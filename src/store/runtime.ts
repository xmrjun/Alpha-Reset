import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalCa } from '../addresses.js';
import { resolveGeckoNetwork } from '../api/networks.js';
import { createSeriesStore, isSupportedMarketSeries } from './series.js';
import type { RateLimitStore } from '../api/erwa.js';
import type { StrategyConfig } from '../config/strategy.js';
import { RPS_KEYS, TAG_DETAILS, emptyScores, type RpsKey, type RpsScores } from '../market.js';
import type { RuleOutput } from '../rules/evaluate.js';
import type { RpsBounds } from '../indicators/observation-rps.js';
import type { AlertTag, DexSnapshot } from '../types.js';
import type { StoreDatabase } from './db.js';
import type { PoolRow } from './pool.js';

export interface RoundMember {
  pool: PoolRow;
  totalMentions: number;
  dex: DexSnapshot | null;
  dexAt: number | null;
  /** absent = 上游成功应答但该 CA 没有任何交易对（已验证无市场），与请求失败的 error 区分。 */
  dexStatus: 'pending' | 'ok' | 'error' | 'absent';
  qualified: boolean;
  klineStatus: 'skipped' | 'ready' | 'error';
  rpsScores: RpsScores;
  rpsBounds?: RpsBounds | undefined;
  /** 仅供页面展示的数学范围，不作为规则或通知输入。 */
  rpsDisplayBounds?: RpsBounds | undefined;
  /** undefined 仅兼容旧离线输入；null 表示尚无已验证行情。 */
  seriesId?: string | null | undefined;
  /** 同一计算 T 未首次绑定前预定来源，防迟到数据改用另一供应商。 */
  plannedSource?: 'geckoterminal' | 'gmgn' | 'binance' | undefined;
  result: RuleOutput | null;
}
export interface RpsCoverage {
  eligible: number; available: number; complete: boolean; source: 'dex_h24' | 'kline';
  unknownAge?: number | undefined; inactive?: number | undefined; illiquid?: number | undefined; ageConfirmedByHistory?: number | undefined; missingCurrent?: number | undefined; missingStart?: number | undefined; boundedPassCount?: number | undefined;
}
export interface RoundSnapshot {
  version: 1;
  strategyKey: string;
  startedAt: number;
  completedAt: number | null;
  status: 'running' | 'complete' | 'partial' | 'halted' | 'failed';
  boardComplete: boolean;
  sourceCount: number;
  sourceLimited: boolean;
  failures: number;
  quota: { used: number; limit: number };
  coverage: Record<RpsKey, RpsCoverage>;
  /** RPS 是否仍是上一轮的值（本轮尚未算出新值时为 true），供前端标注数据时效 */
  rpsFromPreviousRound: boolean;
  members: RoundMember[];
  /** 固定收盘基准内的数据修订；不改变 startedAt。 */
  rpsRevision?: number | undefined;
  rpsInputKey?: string | undefined;
  /** 三群摘要全部成功后发布完整观察池的时间，与行情轮次/评分时间独立。 */
  observedAt?: number | undefined;
  addedCount?: number | undefined;
  removedCount?: number | undefined;
}

export type RpsFallbackRound = RoundSnapshot & { originalPoolSize: number };

export interface CollectionAttempt {
  /** 单调队列顺序：新成员入队，实际尝试前移到队尾。 */
  sequence: number;
  attemptedAt: number | null;
}

const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nullableNumber = z.number().nullable();
const scoresSchema = z.object({ r16: nullableNumber, r56: nullableNumber, r96: nullableNumber, r288: nullableNumber, r672: nullableNumber });
const boundSchema = z.object({ lower: z.number().min(0).max(100), upper: z.number().min(0).max(100),
  status: z.enum(['exact', 'pass', 'fail', 'unknown']) }).refine((bound) => bound.lower <= bound.upper).nullable();
const boundsSchema = z.object({ r16: boundSchema, r56: boundSchema, r96: boundSchema, r288: boundSchema, r672: boundSchema });
const coverageSchema = z.object({ eligible: z.number().int().nonnegative(), available: z.number().int().nonnegative(),
  complete: z.boolean(), source: z.enum(['dex_h24', 'kline']),
  unknownAge: z.number().int().nonnegative().optional(), inactive: z.number().int().nonnegative().optional(), ageConfirmedByHistory: z.number().int().nonnegative().optional(), missingCurrent: z.number().int().nonnegative().optional(),
  missingStart: z.number().int().nonnegative().optional(), illiquid: z.number().int().nonnegative().optional(),
  boundedPassCount: z.number().int().nonnegative().optional() });
const roundSchema: z.ZodType<RoundSnapshot> = z.object({
  version: z.literal(1), strategyKey: z.string(), startedAt: stamp, completedAt: stamp.nullable(),
  status: z.enum(['running', 'complete', 'partial', 'halted', 'failed']), boardComplete: z.boolean(),
  sourceCount: z.number().int().nonnegative(), sourceLimited: z.boolean(), failures: z.number().int().nonnegative(),
  quota: z.object({ used: z.number().int().nonnegative(), limit: z.number().int().positive() }),
  coverage: z.object({ r16: coverageSchema, r56: coverageSchema, r96: coverageSchema, r288: coverageSchema, r672: coverageSchema }),
  rpsFromPreviousRound: z.boolean().default(false),
  rpsRevision: z.number().int().positive().optional(), rpsInputKey: z.string().min(1).optional(),
  observedAt: stamp.optional(), addedCount: z.number().int().nonnegative().optional(), removedCount: z.number().int().nonnegative().optional(),
  members: z.array(z.object({
    pool: z.object({ ca: z.string(), symbol: z.string().nullable(), chain: z.string().nullable(),
      marketCap: nullableNumber, liquidity: nullableNumber, volume24h: nullableNumber, groupName: z.string().nullable(),
      latestMentionTime: stamp.nullable(), tokenName: z.string().nullable(), firstSeenAt: stamp, listedAt: stamp.nullable(), updatedAt: stamp }),
    totalMentions: z.number().int().nonnegative(), dexAt: stamp.nullable(), dexStatus: z.enum(['pending', 'ok', 'error', 'absent']),
    qualified: z.boolean(), klineStatus: z.enum(['skipped', 'ready', 'error']), rpsScores: scoresSchema,
    rpsBounds: boundsSchema.optional(), rpsDisplayBounds: boundsSchema.optional(), seriesId: z.string().min(1).nullable().optional(),
    plannedSource: z.enum(['geckoterminal', 'gmgn', 'binance']).optional(),
    dex: z.object({ pairAddress: z.string().nullable(), chainId: z.string().nullable(), priceUsd: nullableNumber, marketCap: nullableNumber, liquidityUsd: nullableNumber, pairCreatedAt: stamp.nullable(),
      priceChange: z.object({ m5: nullableNumber, h1: nullableNumber, h6: nullableNumber, h24: nullableNumber }) }).nullable(),
    result: z.object({ passed: z.boolean(), reasons: z.object({ a1: z.boolean(), a2: z.boolean(), a3: z.boolean(), a4: z.boolean() }),
      newMoments: z.array(z.object({ moment: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
        barTime: stamp, price: z.number() })), tags: z.array(z.enum(Object.keys(TAG_DETAILS) as [AlertTag, ...AlertTag[]])) }).nullable(),
  })),
});

const fallbackSchema: z.ZodType<RpsFallbackRound> = z.intersection(roundSchema,
  z.object({ originalPoolSize: z.number().int().nonnegative() }));

export function strategyKey(cfg: StrategyConfig): string {
  return createHash('sha256').update('market-contract-v2:').update(JSON.stringify(cfg)).digest('hex');
}

export function initialRound(cfg: StrategyConfig, now: number): RoundSnapshot {
  return { version: 1, strategyKey: strategyKey(cfg), startedAt: now, completedAt: null, status: 'running',
    boardComplete: false, sourceCount: 0, sourceLimited: false, failures: 0,
    quota: { used: 0, limit: cfg.quota.dailyLimit }, members: [], rpsFromPreviousRound: false, coverage: Object.fromEntries(RPS_KEYS.map((key) =>
      [key, { eligible: 0, available: 0, complete: false, source: 'kline' }])) as RoundSnapshot['coverage'] };
}

export function isRoundFresh(round: RoundSnapshot | null, cfg: StrategyConfig, now: number): boolean {
  return round !== null && round.strategyKey === strategyKey(cfg) && round.boardComplete
    && (round.status === 'complete' || round.status === 'partial') && round.completedAt !== null
    && now >= round.startedAt && now - round.completedAt < cfg.schedule.mainLoopMinutes * 60_000;
}

type CompletedRpsRound = RoundSnapshot & {
  boardComplete: true; rpsFromPreviousRound: false;
  status: 'complete' | 'partial'; completedAt: number;
};

/** 展示缓存只接收已完成整池计算的结果；不改变规则层的新鲜度要求。 */
function isCompletedRpsRound(round: RoundSnapshot | null): round is CompletedRpsRound {
  return round !== null && round.boardComplete && !round.rpsFromPreviousRound
    && (round.status === 'complete' || round.status === 'partial')
    && round.completedAt !== null && round.completedAt >= round.startedAt;
}

function hasRpsValues(round: RoundSnapshot): boolean {
  return round.members.some((member) => RPS_KEYS.some((key) => member.rpsScores[key] !== null
    || member.rpsDisplayBounds?.[key] != null || member.rpsBounds?.[key] != null));
}

export class RuntimeStateError extends Error {
  readonly code = 'RUNTIME_STATE_INVALID';
  constructor() { super('运行快照格式无效'); }
}

/** Web 专用只读投影：调用方提供同一事务捕获的 payload；缓存值不得修改。 */
export interface RuntimeReadOptions {
  payload: (key: string) => string | undefined;
  cacheParsed?: boolean;
}
export function createRuntimeStore(db: StoreDatabase, clock = Date.now,
  onStaleSnapshot?: (key: string) => void, readOptions?: RuntimeReadOptions) {
  const parsedCache = new Map<string, { payload: string; schema: unknown; value: unknown }>();
  const marketSeries = createSeriesStore(db);
  const select = db.prepare('SELECT payload FROM runtime_state WHERE key = ?');
  const put = db.prepare(`INSERT INTO runtime_state (key, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`);
  /**
   * 读取快照。解析失败时**丢弃而非抛错** —— 快照只是上一轮的缓存，
   * 字段演进（例如 DexSnapshot 新增 pairAddress/chainId）会让旧记录解析不过，
   * 若直接抛错会导致整个进程起不来，且只能靠手工删库恢复。
   * 丢弃的代价仅是本轮重新拉一次数据。
   */
  function get<T>(key: string, schema: z.ZodType<T>): T | null {
    const payload = readOptions ? readOptions.payload(key) : (select.get(key) as { payload: string } | undefined)?.payload;
    if (payload === undefined) { parsedCache.delete(key); return null; }
    const cached = readOptions?.cacheParsed ? parsedCache.get(key) : undefined;
    if (cached?.payload === payload && cached.schema === schema) return cached.value as T | null;
    let value: T | null = null;
    try {
      const parsed = schema.safeParse(JSON.parse(payload));
      if (parsed.success) value = parsed.data;
    } catch { /* 损坏的缓存与 schema 不符一样丢弃，不回显 payload。 */ }
    if (readOptions?.cacheParsed) parsedCache.set(key, { payload, schema, value });
    if (value === null) onStaleSnapshot?.(key);
    return value;
  }
  const listingSchema = z.object({ listedAt: stamp });
  const cooldownSchema = z.object({ until: stamp });
  const rateLimitStore: RateLimitStore = {
    getUntil: () => get('api_cooldown', cooldownSchema)?.until ?? 0,
    setUntil(until) {
      const value = cooldownSchema.parse({ until: Math.max(until, rateLimitStore.getUntil()) });
      put.run('api_cooldown', JSON.stringify(value), clock());
    },
  };
  const geckoRateLimitStore: RateLimitStore = {
    getUntil: () => get('gecko_cooldown', cooldownSchema)?.until ?? 0,
    setUntil(until) {
      const value = cooldownSchema.parse({ until: Math.max(until, geckoRateLimitStore.getUntil()) });
      put.run('gecko_cooldown', JSON.stringify(value), clock());
    },
  };
  const saveRound = db.transaction((round: RoundSnapshot): void => {
    const parsed = roundSchema.safeParse(round);
    if (!parsed.success) throw new RuntimeStateError();
    const writtenAt = clock();
    const previousDisplay = get('last_rps_round', roundSchema);
    if (isCompletedRpsRound(parsed.data) && isCompletedRpsRound(previousDisplay)
      && previousDisplay.strategyKey === parsed.data.strategyKey && previousDisplay.startedAt < parsed.data.startedAt) {
      for (const member of parsed.data.members) {
        if (member.seriesId !== null || member.plannedSource !== 'gmgn') continue;
        const network = resolveGeckoNetwork(member.pool.chain ?? member.dex?.chainId ?? '');
        const active = network ? marketSeries.getActive(network, member.pool.ca) : null;
        if (!isSupportedMarketSeries(active) || active.source !== 'geckoterminal') continue;
        const saved = previousDisplay.members.find((item) => item.seriesId === active.id
          && canonicalCa(item.pool.ca) === canonicalCa(member.pool.ca)
          && resolveGeckoNetwork(item.pool.chain ?? item.dex?.chainId ?? '') === network);
        if (!saved || !hasRpsValues({ ...previousDisplay, members: [saved] })) continue;
        const fallbackKey = 'rps_fallback:' + active.id;
        const existing = get(fallbackKey, fallbackSchema);
        if (existing && existing.startedAt >= previousDisplay.startedAt) continue;
        const fallback: RpsFallbackRound = { ...previousDisplay, members: [saved], originalPoolSize: previousDisplay.members.length };
        put.run(fallbackKey, JSON.stringify(fallbackSchema.parse(fallback)), writtenAt);
      }
    }
    if (isCompletedRpsRound(parsed.data) && hasRpsValues(parsed.data)) {
      put.run('last_rps_round', JSON.stringify(parsed.data), writtenAt);
    } else {
      const cached = get('last_rps_round', roundSchema);
      if (!isCompletedRpsRound(cached) || cached.strategyKey !== parsed.data.strategyKey || !hasRpsValues(cached)) {
        // 升级后的第一次运行态写入，先保留同口径的最后一次已完成结果。
        const previous = get('last_round', roundSchema);
        if (isCompletedRpsRound(previous) && previous.strategyKey === parsed.data.strategyKey && hasRpsValues(previous)) {
          put.run('last_rps_round', JSON.stringify(previous), writtenAt);
        }
      }
    }
    put.run('last_round', JSON.stringify(parsed.data), writtenAt);
  });
  function checkedRound(round: RoundSnapshot): RoundSnapshot {
    const parsed = roundSchema.safeParse(round);
    if (!parsed.success) throw new RuntimeStateError();
    return parsed.data;
  }
  const saveObservationRound = db.transaction((round: RoundSnapshot): void => {
    const parsed = checkedRound(round);
    if (!parsed.boardComplete) throw new RuntimeStateError();
    const previous = get('observation_round', roundSchema);
    // 长行情轮次不能把后来独立发现的成员集合覆盖回去。
    if (previous && (previous.observedAt ?? previous.startedAt) > (parsed.observedAt ?? parsed.startedAt)) return;
    put.run('observation_round', JSON.stringify(parsed), clock());
  });
  const saveCollectionRound = db.transaction((round: RoundSnapshot, publishObservation = true): void => {
    const parsed = checkedRound(round);
    put.run('collection_round', JSON.stringify(parsed), clock());
    // 默认仅兼容旧 collectOnce；生产队列传 false，由发现流程独立发布完整池。
    if (publishObservation && parsed.boardComplete) saveObservationRound(parsed);
  });
  const attemptSchema = z.object({ sequence: stamp, attemptedAt: stamp.nullable() });
  const sequenceSchema = z.object({ sequence: stamp });
  const attemptKey = (network: string, ca: string) => 'collection_attempt:' + JSON.stringify([network, canonicalCa(ca)]);
  function nextSequence(): number {
    const sequence = (get('collection_sequence', sequenceSchema)?.sequence ?? 0) + 1;
    const value = sequenceSchema.parse({ sequence });
    put.run('collection_sequence', JSON.stringify(value), clock());
    return sequence;
  }
  const ensureCollectionQueue = db.transaction((network: string, ca: string): CollectionAttempt => {
    const key = attemptKey(network, ca);
    const previous = get(key, attemptSchema);
    if (previous) return previous;
    const value = { sequence: nextSequence(), attemptedAt: null };
    put.run(key, JSON.stringify(value), clock());
    return value;
  });
  const recordCollectionAttempt = db.transaction((network: string, ca: string, attemptedAt = clock()): CollectionAttempt => {
    const value = attemptSchema.parse({ sequence: nextSequence(), attemptedAt });
    put.run(attemptKey(network, ca), JSON.stringify(value), clock());
    return value;
  });
  return {
    getDiscoveryRound: () => get('discovery_round', roundSchema),
    saveDiscoveryRound(round: RoundSnapshot): void { put.run('discovery_round', JSON.stringify(checkedRound(round)), clock()); },
    saveObservationRound,
    ensureCollectionQueue,
    getCollectionAttempt: (network: string, ca: string): CollectionAttempt | null => get(attemptKey(network, ca), attemptSchema),
    recordCollectionAttempt,
    getCollectionRound: () => get('collection_round', roundSchema),
    getObservationRound(): RoundSnapshot | null {
      const observation = get('observation_round', roundSchema);
      if (observation?.boardComplete) return observation;
      const previous = get('last_round', roundSchema);
      // boardComplete 只证明群组发现完整，允许从旧 running/halted 的完整池启动。
      // 调用方仍须验证策略/来源，并将旧评分清空后重算。
      if (previous?.boardComplete) return previous;
      const cached = get('last_rps_round', roundSchema);
      return isCompletedRpsRound(cached) ? cached : null;
    },
    saveCollectionRound,
    getRound: () => get('last_round', roundSchema),
    /** 单资产等待换源的旧展示值；members只含该资产，原池人数另存，不能进入规则或全池统计。 */
    getRpsFallbackRound(seriesId: string): RpsFallbackRound | null { return get('rps_fallback:' + seriesId, fallbackSchema); },
    getRpsRound(): RoundSnapshot | null {
      const cached = get('last_rps_round', roundSchema);
      if (isCompletedRpsRound(cached)) return cached;
      // 只读兼容尚未写入展示缓存的升级现场，不刷新原结果的任何时间。
      const current = get('last_round', roundSchema);
      return isCompletedRpsRound(current) ? current : null;
    },
    saveRound,
    getListing(ca: string, network?: string): number | null {
      return get(network ? 'listing:' + network + ':' + canonicalCa(ca) : 'listing:' + canonicalCa(ca), listingSchema)?.listedAt ?? null;
    },
    cacheListing(ca: string, listedAt: number, network?: string): number {
      const key = network ? 'listing:' + network + ':' + canonicalCa(ca) : 'listing:' + canonicalCa(ca);
      const existing = get(key, listingSchema);
      if (existing) return existing.listedAt;
      const value = listingSchema.parse({ listedAt });
      put.run(key, JSON.stringify(value), clock());
      return listedAt;
    },
    rateLimitStore,
    geckoRateLimitStore,
  };
}

export function pendingMember(pool: PoolRow, totalMentions: number): RoundMember {
  return { pool, totalMentions, dex: null, dexAt: null, dexStatus: 'pending', qualified: false,
    klineStatus: 'skipped', rpsScores: emptyScores(), result: null };
}
