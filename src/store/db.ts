import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type StoreDatabase = Database.Database;

/** 显式打开、由调用方关闭；导入模块不创建数据库。 */
export function openDatabase(filename = 'data/alpha-reset.sqlite'): StoreDatabase {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version > 7) throw new Error('数据库版本高于当前程序支持的版本');
    if (version < 1) {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS candles (
            ca TEXT NOT NULL,
            interval TEXT NOT NULL,
            open_time INTEGER NOT NULL,
            open REAL NOT NULL,
            high REAL NOT NULL,
            low REAL NOT NULL,
            close REAL NOT NULL,
            volume REAL NOT NULL,
            PRIMARY KEY (ca, interval, open_time)
          ) WITHOUT ROWID;
          CREATE INDEX IF NOT EXISTS idx_candles_ca_iv_t ON candles(ca, interval, open_time DESC);

          CREATE TABLE IF NOT EXISTS ca_pool (
            ca TEXT PRIMARY KEY,
            symbol TEXT,
            chain TEXT,
            token_name TEXT,
            market_cap REAL,
            liquidity REAL,
            volume_24h REAL,
            group_name TEXT,
            first_seen_at INTEGER NOT NULL,
            listed_at INTEGER,
            latest_mention_time INTEGER,
            updated_at INTEGER NOT NULL
          );

          CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ca TEXT NOT NULL,
            tag TEXT NOT NULL,
            fired_at INTEGER NOT NULL,
            payload TEXT NOT NULL,
            pushed INTEGER NOT NULL DEFAULT 0
          );
          CREATE INDEX IF NOT EXISTS idx_alerts_ca_tag_t ON alerts(ca, tag, fired_at DESC);

          CREATE TABLE IF NOT EXISTS breakout_moments (
            ca TEXT NOT NULL,
            moment INTEGER NOT NULL,
            bar_time INTEGER NOT NULL,
            price REAL NOT NULL,
            detected_at INTEGER NOT NULL,
            PRIMARY KEY (ca, moment)
          );

          CREATE TABLE IF NOT EXISTS api_usage (
            date TEXT PRIMARY KEY,
            calls INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
          );
          PRAGMA user_version = 1;
        `);
      })();
    }
    if (version < 2) {
      db.transaction(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS runtime_state (
          key TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) WITHOUT ROWID;
        PRAGMA user_version = 2;`);
      })();
    }
    if (version < 3) {
      db.transaction(() => {
        // 观察组的历史 CA 全集。board/summary 每群只给 top 200，
        // 拿不到完整历史；此表由 backfill 工具填充，用于扩池与将来回测。
        db.exec(`CREATE TABLE IF NOT EXISTS group_ca_history (
          ca TEXT PRIMARY KEY,
          symbol TEXT,
          chain TEXT,
          group_name TEXT,
          first_mention_id INTEGER NOT NULL,
          first_mention_at INTEGER NOT NULL,
          synced_at INTEGER NOT NULL
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_history_mention ON group_ca_history(first_mention_at DESC);
        CREATE INDEX IF NOT EXISTS idx_history_group ON group_ca_history(group_name);
        PRAGMA user_version = 3;`);
      })();
    }
    if (version < 4) {
      db.transaction(() => {
        // 旧行情来源/交易对无法证明，保留原表，但绝不自动认领到新序列。
        db.exec(`
          CREATE TABLE IF NOT EXISTS market_series (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL CHECK (source IN ('geckoterminal', 'erwa')),
            network TEXT NOT NULL,
            ca TEXT NOT NULL,
            pool_address TEXT NOT NULL,
            currency TEXT NOT NULL CHECK (currency = 'usd'),
            format_version INTEGER NOT NULL CHECK (format_version > 0),
            created_at INTEGER NOT NULL,
            activated_at INTEGER,
            active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
            UNIQUE (source, network, ca, pool_address, currency, format_version)
          ) WITHOUT ROWID;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_market_series_active
            ON market_series(network, ca) WHERE active = 1;

          CREATE TABLE IF NOT EXISTS series_candles (
            series_id TEXT NOT NULL REFERENCES market_series(id),
            interval TEXT NOT NULL,
            open_time INTEGER NOT NULL,
            open REAL NOT NULL,
            high REAL NOT NULL,
            low REAL NOT NULL,
            close REAL NOT NULL,
            volume REAL NOT NULL,
            PRIMARY KEY (series_id, interval, open_time)
          ) WITHOUT ROWID;
          CREATE INDEX IF NOT EXISTS idx_series_candles_t
            ON series_candles(series_id, interval, open_time DESC);

          CREATE TABLE IF NOT EXISTS series_moments (
            series_id TEXT NOT NULL REFERENCES market_series(id),
            moment INTEGER NOT NULL,
            bar_time INTEGER NOT NULL,
            price REAL NOT NULL,
            detected_at INTEGER NOT NULL,
            PRIMARY KEY (series_id, moment)
          ) WITHOUT ROWID;
          PRAGMA user_version = 4;
        `);
      })();
    }
    if (version < 5) {
      // SQLite 的父表重建需在事务外暂关外键；子表不重写，id 不改变。
      // 提交前校验全部外键，成功或异常均恢复连接上的外键约束。
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.exec(`
            CREATE TABLE market_series_v5 (
              id TEXT PRIMARY KEY,
              source TEXT NOT NULL CHECK (source IN ('geckoterminal', 'erwa', 'gmgn')),
              scope TEXT NOT NULL CHECK (scope IN ('pool', 'token')),
              network TEXT NOT NULL,
              ca TEXT NOT NULL,
              pool_address TEXT,
              currency TEXT NOT NULL CHECK (currency = 'usd'),
              format_version INTEGER NOT NULL CHECK (format_version > 0),
              created_at INTEGER NOT NULL,
              activated_at INTEGER,
              active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
              CHECK ((source IN ('geckoterminal', 'erwa') AND scope = 'pool'
                AND pool_address IS NOT NULL AND length(trim(pool_address)) > 0)
                OR (source = 'gmgn' AND scope = 'token' AND pool_address IS NULL)),
              UNIQUE (source, scope, network, ca, pool_address, currency, format_version)
            ) WITHOUT ROWID;
            INSERT INTO market_series_v5
              (id, source, scope, network, ca, pool_address, currency, format_version, created_at, activated_at, active)
              SELECT id, source, 'pool', network, ca, pool_address, currency, format_version, created_at, activated_at, active
              FROM market_series;
            DROP TABLE market_series;
            ALTER TABLE market_series_v5 RENAME TO market_series;
            CREATE UNIQUE INDEX idx_market_series_active
              ON market_series(network, ca) WHERE active = 1;
            -- NULL 不参与普通 UNIQUE 比较；token 序列需另建唯一索引。
            CREATE UNIQUE INDEX idx_market_series_token
              ON market_series(source, network, ca, currency, format_version) WHERE scope = 'token';
          `);
          if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('行情序列迁移外键校验失败');
          db.pragma('user_version = 5');
        })();
      } finally {
        db.pragma('foreign_keys = ON');
      }
    }
    if (version < 6) {
      db.transaction(() => {
        db.exec(`
          -- 告警事后表现。同一张表同时装告警组与对照组：
          -- 每个评分时点 T 下，所有通过 A1∧A2 且当时有收盘价的成员各记一行，
          -- alerted 区分两组，从而可以回答"达标但没告警的那批表现如何"。
          -- entry/exit 必须来自同一条 series（同源），legacy 回填时 series_id 为 NULL。
          CREATE TABLE IF NOT EXISTS alert_outcomes (
            ca TEXT NOT NULL,
            baseline_at INTEGER NOT NULL,
            horizon_hours INTEGER NOT NULL CHECK (horizon_hours > 0),
            alerted INTEGER NOT NULL CHECK (alerted IN (0, 1)),
            tags TEXT NOT NULL DEFAULT '',
            series_id TEXT REFERENCES market_series(id),
            entry_price REAL NOT NULL CHECK (entry_price > 0),
            exit_price REAL CHECK (exit_price IS NULL OR exit_price > 0),
            return_pct REAL,
            settled_at INTEGER,
            recorded_at INTEGER NOT NULL,
            PRIMARY KEY (ca, baseline_at, horizon_hours)
          ) WITHOUT ROWID;
          -- 待结算扫描只关心尚未有结果的行。
          CREATE INDEX IF NOT EXISTS idx_outcomes_pending
            ON alert_outcomes(baseline_at, horizon_hours) WHERE return_pct IS NULL AND settled_at IS NULL;
          CREATE INDEX IF NOT EXISTS idx_outcomes_group
            ON alert_outcomes(horizon_hours, alerted, baseline_at DESC);
        `);
        db.pragma('user_version = 6');
      })();
    }
    if (version < 7) {
      // 表级 CHECK 无法 ALTER，只能重建。与 v5 同样的处理：暂关外键、整表拷贝、
      // 提交前校验全部外键；子表不动，seriesId 不变，历史与告警全部保留。
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.exec(`
            CREATE TABLE market_series_v7 (
              id TEXT PRIMARY KEY,
              source TEXT NOT NULL CHECK (source IN ('geckoterminal', 'erwa', 'gmgn', 'binance')),
              scope TEXT NOT NULL CHECK (scope IN ('pool', 'token')),
              network TEXT NOT NULL,
              ca TEXT NOT NULL,
              pool_address TEXT,
              currency TEXT NOT NULL CHECK (currency = 'usd'),
              format_version INTEGER NOT NULL CHECK (format_version > 0),
              created_at INTEGER NOT NULL,
              activated_at INTEGER,
              active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
              CHECK ((source IN ('geckoterminal', 'erwa') AND scope = 'pool'
                AND pool_address IS NOT NULL AND length(trim(pool_address)) > 0)
                OR (source IN ('gmgn', 'binance') AND scope = 'token' AND pool_address IS NULL)),
              UNIQUE (source, scope, network, ca, pool_address, currency, format_version)
            ) WITHOUT ROWID;
            INSERT INTO market_series_v7 SELECT id, source, scope, network, ca, pool_address,
              currency, format_version, created_at, activated_at, active FROM market_series;
            DROP TABLE market_series;
            ALTER TABLE market_series_v7 RENAME TO market_series;
            CREATE UNIQUE INDEX idx_market_series_active
              ON market_series(network, ca) WHERE active = 1;
            -- NULL 不参与普通 UNIQUE 比较；token 序列按来源各自唯一。
            CREATE UNIQUE INDEX idx_market_series_token
              ON market_series(source, network, ca, currency, format_version) WHERE scope = 'token';
          `);
          if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('行情序列 v7 迁移外键校验失败');
          db.pragma('user_version = 7');
        })();
      } finally {
        db.pragma('foreign_keys = ON');
      }
    }
    // v5 正式启用前补充切源审计；幂等兼容先前隔离验证产生的 v5 库。
    db.exec(`CREATE TABLE IF NOT EXISTS market_series_switches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      network TEXT NOT NULL,
      ca TEXT NOT NULL,
      previous_series_id TEXT REFERENCES market_series(id),
      next_series_id TEXT NOT NULL REFERENCES market_series(id),
      switched_at INTEGER NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_series_switches_asset ON market_series_switches(network, ca, switched_at);`);

    // agent 工具调用的证据链。与上面那张表一样用 IF NOT EXISTS 无条件建 ——
    // 放进版本化迁移块的话，已经是 version 7 的线上库永远不会执行到。
    db.exec(`CREATE TABLE IF NOT EXISTS agent_tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      visitor TEXT NOT NULL,
      tool TEXT NOT NULL,
      arg_digest TEXT NOT NULL,
      cached INTEGER NOT NULL,
      cost_usd REAL,
      outcome TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_quota ON agent_tool_calls(tool, at, outcome);
    CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_visitor ON agent_tool_calls(tool, visitor, at);`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
