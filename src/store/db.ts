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
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version > 2) throw new Error('数据库版本高于当前程序支持的版本');
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
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
