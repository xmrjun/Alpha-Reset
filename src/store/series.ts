import { createHash } from 'node:crypto';
import { canonicalCa } from '../addresses.js';
import type { BreakoutMoment, Candle, Interval } from '../types.js';
import type { StoreDatabase } from './db.js';

/** USD / 指定目标 token / 供应商确认的空周期，变更口径时必须建立新序列。 */
export const MARKET_SERIES_FORMAT_VERSION = 1;

interface MarketSeriesCommon {
  /** 规范内部链 ID；API 适配器负责转换为各供应商的链参数。 */
  network: string;
  ca: string;
  currency: 'usd';
  formatVersion: number;
}

type PoolSeriesIdentity = MarketSeriesCommon & {
  source: 'geckoterminal' | 'erwa';
  scope?: 'pool' | undefined;
  poolAddress: string;
};
/** token 范围来源：按代币地址取数，不绑定固定池。各来源仍是彼此独立的序列。 */
export const TOKEN_SOURCES = ['gmgn', 'binance'] as const;
export type TokenSource = typeof TOKEN_SOURCES[number];
type TokenSeriesIdentity = MarketSeriesCommon & {
  source: TokenSource;
  scope: 'token';
  poolAddress: null;
};
export type MarketSeriesIdentity = PoolSeriesIdentity | TokenSeriesIdentity;
type NormalizedSeriesIdentity = (PoolSeriesIdentity & { scope: 'pool' }) | TokenSeriesIdentity;
export type MarketSeries = NormalizedSeriesIdentity & {
  id: string;
  createdAt: number;
  activatedAt: number | null;
  active: boolean;
};
export type SupportedMarketSeries = MarketSeries & { source: 'geckoterminal' | TokenSource };

/** 来源白名单与口径验证；读取具体成员时还必须核验 network + CA。 */
export function isSupportedMarketSeries(series: MarketSeries | null | undefined): series is SupportedMarketSeries {
  if (!series || series.currency !== 'usd' || series.formatVersion !== MARKET_SERIES_FORMAT_VERSION
    || typeof series.network !== 'string' || !series.network || series.network !== series.network.trim()
    || typeof series.ca !== 'string' || !series.ca || series.ca !== series.ca.trim()
    || series.ca !== canonicalCa(series.ca)) return false;
  if ((TOKEN_SOURCES as readonly string[]).includes(series.source)) {
    return series.scope === 'token' && series.poolAddress === null;
  }
  return series.source === 'geckoterminal' && series.scope === 'pool'
    && typeof series.poolAddress === 'string' && series.poolAddress.length > 0
    && series.poolAddress === series.poolAddress.trim() && series.poolAddress === canonicalCa(series.poolAddress);
}

export class MarketSeriesError extends Error {
  constructor(readonly code: 'SERIES_NOT_FOUND' | 'SERIES_IDENTITY_INVALID' | 'SERIES_EMPTY' | 'SERIES_ALREADY_PINNED' | 'SERIES_CONFLICT' | 'SERIES_SWITCH_INVALID', message: string) {
    super(message);
    this.name = 'MarketSeriesError';
  }
}

type StoredSeries = Omit<MarketSeries, 'active'> & { active: number };

function normalizeIdentity(identity: MarketSeriesIdentity): NormalizedSeriesIdentity {
  const text = [identity.network, identity.ca];
  if (text.some((value) => typeof value !== 'string' || !value || value !== value.trim())
    || identity.currency !== 'usd' || !Number.isSafeInteger(identity.formatVersion) || identity.formatVersion < 1) {
    throw new MarketSeriesError('SERIES_IDENTITY_INVALID', '行情序列身份无效');
  }
  if ((TOKEN_SOURCES as readonly string[]).includes(identity.source)) {
    if (identity.scope !== 'token' || identity.poolAddress !== null) {
      throw new MarketSeriesError('SERIES_IDENTITY_INVALID', 'token 范围来源必须使用独立行情序列');
    }
    return { ...identity, ca: canonicalCa(identity.ca) } as NormalizedSeriesIdentity;
  }
  if (!['geckoterminal', 'erwa'].includes(identity.source) || (identity.scope !== undefined && identity.scope !== 'pool')
    || typeof identity.poolAddress !== 'string' || !identity.poolAddress || identity.poolAddress !== identity.poolAddress.trim()) {
    throw new MarketSeriesError('SERIES_IDENTITY_INVALID', '固定池行情序列身份无效');
  }
  return { ...identity, scope: 'pool', ca: canonicalCa(identity.ca), poolAddress: canonicalCa(identity.poolAddress) };
}

function readSeries(row: unknown): MarketSeries | null {
  if (!row) return null;
  const stored = row as StoredSeries;
  return { ...stored, active: stored.active === 1 } as MarketSeries;
}

export function createSeriesStore(db: StoreDatabase) {
  const columns = `id, source, scope, network, ca, pool_address AS poolAddress, currency,
    format_version AS formatVersion, created_at AS createdAt, activated_at AS activatedAt, active`;
  const selectSeries = db.prepare(`SELECT ${columns} FROM market_series WHERE id = ?`);
  const selectActive = db.prepare(`SELECT ${columns} FROM market_series WHERE network = ? AND ca = ? AND active = 1`);
  const selectToken = db.prepare(`SELECT ${columns} FROM market_series WHERE source = ?
    AND scope = 'token' AND network = ? AND ca = ? AND currency = 'usd' AND format_version = ?`);
  const insertSeries = db.prepare(`INSERT INTO market_series
    (id, source, scope, network, ca, pool_address, currency, format_version, created_at)
    VALUES (@id, @source, @scope, @network, @ca, @poolAddress, @currency, @formatVersion, @createdAt)
    ON CONFLICT(id) DO NOTHING`);
  const activate = db.prepare('UPDATE market_series SET active = 1, activated_at = ? WHERE id = ? AND active = 0');
  const hasCandles = db.prepare('SELECT 1 FROM series_candles WHERE series_id = ? LIMIT 1');
  const upsertCandle = db.prepare(`INSERT INTO series_candles
    (series_id, interval, open_time, open, high, low, close, volume)
    VALUES (@seriesId, @interval, @openTime, @open, @high, @low, @close, @volume)
    ON CONFLICT(series_id, interval, open_time) DO UPDATE SET
      open = excluded.open, high = excluded.high, low = excluded.low,
      close = excluded.close, volume = excluded.volume`);
  const selectCandles = db.prepare(`SELECT open_time AS openTime, open, high, low, close, volume
    FROM series_candles WHERE series_id = ? AND interval = ? ORDER BY open_time DESC LIMIT ?`);
  const upsertMoment = db.prepare(`INSERT INTO series_moments (series_id, moment, bar_time, price, detected_at)
    VALUES (@seriesId, @moment, @barTime, @price, @detectedAt)
    ON CONFLICT(series_id, moment) DO UPDATE SET
      bar_time = excluded.bar_time, price = excluded.price, detected_at = excluded.detected_at
    WHERE excluded.bar_time > series_moments.bar_time
      OR (excluded.bar_time = series_moments.bar_time AND excluded.price > series_moments.price)`);
  const selectMoments = db.prepare(`SELECT moment, bar_time AS barTime, price
    FROM series_moments WHERE series_id = ? ORDER BY moment`);

  function getSeries(id: string): MarketSeries | null { return readSeries(selectSeries.get(id)); }
  function requireSeries(id: string): MarketSeries {
    const series = getSeries(id);
    if (!series) throw new MarketSeriesError('SERIES_NOT_FOUND', '行情序列不存在');
    return series;
  }
  function getActive(network: string, ca: string): MarketSeries | null {
    return readSeries(selectActive.get(network, canonicalCa(ca)));
  }

  return {
    getSeries,
    getActive,
    /** source 省略时沿用既有 GMGN 调用语义，避免改动所有旧调用点。 */
    getTokenSeries(network: string, ca: string, source: TokenSource = 'gmgn'): MarketSeries | null {
      return readSeries(selectToken.get(source, network, canonicalCa(ca), MARKET_SERIES_FORMAT_VERSION));
    },
    /** 评分事务显式选择新来源；CAS防止抢占，旧历史和新高时刻各自保留。 */
    switchActiveSeries: db.transaction((seriesId: string, expectedActiveId: string | null, now: number, reason: string): MarketSeries => {
      const next = requireSeries(seriesId);
      if (!isSupportedMarketSeries(next) || !Number.isSafeInteger(now) || now < next.createdAt
        || !/^[a-z][a-z0-9_]{0,63}$/.test(reason)) {
        throw new MarketSeriesError('SERIES_SWITCH_INVALID', '行情切换参数或来源无效');
      }
      const current = getActive(next.network, next.ca);
      if ((current?.id ?? null) !== expectedActiveId) {
        throw new MarketSeriesError('SERIES_CONFLICT', '行情来源已被其他操作修改');
      }
      if (current?.id === next.id) return current;
      if (!hasCandles.get(seriesId)) throw new MarketSeriesError('SERIES_EMPTY', '尚无有效历史，不能切换来源');
      if (current?.activatedAt !== null && current?.activatedAt !== undefined && now < current.activatedAt) {
        throw new MarketSeriesError('SERIES_SWITCH_INVALID', '行情切换时间不能倒退');
      }
      if (current) db.prepare('UPDATE market_series SET active = 0 WHERE id = ? AND active = 1').run(current.id);
      activate.run(now, seriesId);
      db.prepare(`INSERT INTO market_series_switches
        (network, ca, previous_series_id, next_series_id, switched_at, reason) VALUES (?, ?, ?, ?, ?, ?)` )
        .run(next.network, next.ca, current?.id ?? null, next.id, now, reason);
      return requireSeries(seriesId);
    }),
    /** 只创建身份；API 失败、空响应和迁移都不能激活序列。 */
    ensureSeries: db.transaction((identity: MarketSeriesIdentity, now: number): MarketSeries => {
      const normalized = normalizeIdentity(identity);
      // v4 固定池的 hash 输入保持不变，避免迁移或省略 scope 时生成第二份历史。
      const identityKey = normalized.scope === 'pool'
        ? [normalized.source, normalized.network, normalized.ca, normalized.poolAddress, normalized.currency, normalized.formatVersion]
        : [normalized.source, normalized.scope, normalized.network, normalized.ca, normalized.poolAddress, normalized.currency, normalized.formatVersion];
      const id = createHash('sha256').update(JSON.stringify(identityKey)).digest('hex');
      insertSeries.run({ ...normalized, id, createdAt: now });
      return requireSeries(id);
    }),
    /** 调用方应与本轮全部 K 线写入放在同一外层事务中；已有固定池时不允许自动切换。 */
    activateSeries: db.transaction((seriesId: string, now: number): MarketSeries => {
      const series = requireSeries(seriesId);
      const active = getActive(series.network, series.ca);
      if (active && active.id !== seriesId) {
        throw new MarketSeriesError('SERIES_ALREADY_PINNED', '该链的 CA 已固定其他行情序列，切换需要显式迁移');
      }
      if (!hasCandles.get(seriesId)) throw new MarketSeriesError('SERIES_EMPTY', '没有成功写入 K 线，不能激活行情序列');
      activate.run(now, seriesId);
      return requireSeries(seriesId);
    }),
    upsertCandles: db.transaction((seriesId: string, interval: Interval, candles: Candle[]): void => {
      requireSeries(seriesId);
      for (const candle of candles) upsertCandle.run({ ...candle, seriesId, interval });
    }),
    /** 与旧 candle store 保持一致：倒序；limit 省略表示全部历史。 */
    getCandles(seriesId: string, interval: Interval, limit?: number): Candle[] {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new RangeError('limit 必须是非负整数');
      return selectCandles.all(seriesId, interval, limit ?? -1) as Candle[];
    },
    upsertMoments: db.transaction((seriesId: string, moments: BreakoutMoment[], detectedAt: number): void => {
      requireSeries(seriesId);
      for (const moment of moments) upsertMoment.run({ ...moment, seriesId, detectedAt });
    }),
    getMoments(seriesId: string): BreakoutMoment[] { return selectMoments.all(seriesId) as BreakoutMoment[]; },
  };
}
