import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalCa } from '../addresses.js';
import type { RateLimitStore } from '../api/erwa.js';
import type { StrategyConfig } from '../config/strategy.js';
import { RPS_KEYS, TAG_DETAILS, emptyScores, type RpsKey, type RpsScores } from '../market.js';
import type { RuleOutput } from '../rules/evaluate.js';
import type { AlertTag, DexSnapshot } from '../types.js';
import type { StoreDatabase } from './db.js';
import type { PoolRow } from './pool.js';

export interface RoundMember {
  pool: PoolRow;
  totalMentions: number;
  dex: DexSnapshot | null;
  dexAt: number | null;
  dexStatus: 'pending' | 'ok' | 'error';
  qualified: boolean;
  klineStatus: 'skipped' | 'ready' | 'error';
  rpsScores: RpsScores;
  result: RuleOutput | null;
}
export interface RpsCoverage { eligible: number; available: number; complete: boolean; source: 'dex_h24' | 'kline' }
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
  members: RoundMember[];
}

const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nullableNumber = z.number().nullable();
const scoresSchema = z.object({ r16: nullableNumber, r56: nullableNumber, r96: nullableNumber, r288: nullableNumber, r672: nullableNumber });
const coverageSchema = z.object({ eligible: z.number().int().nonnegative(), available: z.number().int().nonnegative(),
  complete: z.boolean(), source: z.enum(['dex_h24', 'kline']) });
const roundSchema: z.ZodType<RoundSnapshot> = z.object({
  version: z.literal(1), strategyKey: z.string(), startedAt: stamp, completedAt: stamp.nullable(),
  status: z.enum(['running', 'complete', 'partial', 'halted', 'failed']), boardComplete: z.boolean(),
  sourceCount: z.number().int().nonnegative(), sourceLimited: z.boolean(), failures: z.number().int().nonnegative(),
  quota: z.object({ used: z.number().int().nonnegative(), limit: z.number().int().positive() }),
  coverage: z.object({ r16: coverageSchema, r56: coverageSchema, r96: coverageSchema, r288: coverageSchema, r672: coverageSchema }),
  members: z.array(z.object({
    pool: z.object({ ca: z.string(), symbol: z.string().nullable(), chain: z.string().nullable(),
      marketCap: nullableNumber, liquidity: nullableNumber, volume24h: nullableNumber, groupName: z.string().nullable(),
      latestMentionTime: stamp.nullable(), tokenName: z.string().nullable(), firstSeenAt: stamp, listedAt: stamp.nullable(), updatedAt: stamp }),
    totalMentions: z.number().int().nonnegative(), dexAt: stamp.nullable(), dexStatus: z.enum(['pending', 'ok', 'error']),
    qualified: z.boolean(), klineStatus: z.enum(['skipped', 'ready', 'error']), rpsScores: scoresSchema,
    dex: z.object({ pairAddress: z.string().nullable(), chainId: z.string().nullable(), priceUsd: nullableNumber, marketCap: nullableNumber, liquidityUsd: nullableNumber, pairCreatedAt: stamp.nullable(),
      priceChange: z.object({ m5: nullableNumber, h1: nullableNumber, h6: nullableNumber, h24: nullableNumber }) }).nullable(),
    result: z.object({ passed: z.boolean(), reasons: z.object({ a1: z.boolean(), a2: z.boolean(), a3: z.boolean(), a4: z.boolean() }),
      newMoments: z.array(z.object({ moment: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
        barTime: stamp, price: z.number() })), tags: z.array(z.enum(Object.keys(TAG_DETAILS) as [AlertTag, ...AlertTag[]])) }).nullable(),
  })),
});

export function strategyKey(cfg: StrategyConfig): string {
  return createHash('sha256').update(JSON.stringify(cfg)).digest('hex');
}

export function initialRound(cfg: StrategyConfig, now: number): RoundSnapshot {
  return { version: 1, strategyKey: strategyKey(cfg), startedAt: now, completedAt: null, status: 'running',
    boardComplete: false, sourceCount: 0, sourceLimited: false, failures: 0,
    quota: { used: 0, limit: cfg.quota.dailyLimit }, members: [], coverage: Object.fromEntries(RPS_KEYS.map((key) =>
      [key, { eligible: 0, available: 0, complete: false, source: key === 'r96' ? 'dex_h24' : 'kline' }])) as RoundSnapshot['coverage'] };
}

export function isRoundFresh(round: RoundSnapshot | null, cfg: StrategyConfig, now: number): boolean {
  return round !== null && round.strategyKey === strategyKey(cfg) && round.boardComplete
    && (round.status === 'complete' || round.status === 'partial') && round.completedAt !== null
    && now >= round.startedAt && now - round.completedAt < cfg.schedule.mainLoopMinutes * 60_000;
}

export class RuntimeStateError extends Error {
  readonly code = 'RUNTIME_STATE_INVALID';
  constructor() { super('运行快照格式无效'); }
}

export function createRuntimeStore(db: StoreDatabase, clock = Date.now,
  onStaleSnapshot?: (key: string) => void) {
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
    const row = select.get(key) as { payload: string } | undefined;
    if (!row) return null;
    const parsed = schema.safeParse(JSON.parse(row.payload));
    if (parsed.success) return parsed.data;
    onStaleSnapshot?.(key);
    return null;
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
  return {
    getRound: () => get('last_round', roundSchema),
    saveRound(round: RoundSnapshot): void {
      const parsed = roundSchema.safeParse(round);
      if (!parsed.success) throw new RuntimeStateError();
      put.run('last_round', JSON.stringify(parsed.data), clock());
    },
    getListing(ca: string): number | null { return get(`listing:${canonicalCa(ca)}`, listingSchema)?.listedAt ?? null; },
    cacheListing(ca: string, listedAt: number): number {
      const existing = get(`listing:${canonicalCa(ca)}`, listingSchema);
      if (existing) return existing.listedAt;
      const value = listingSchema.parse({ listedAt });
      put.run(`listing:${canonicalCa(ca)}`, JSON.stringify(value), clock());
      return listedAt;
    },
    rateLimitStore,
  };
}

export function pendingMember(pool: PoolRow, totalMentions: number): RoundMember {
  return { pool, totalMentions, dex: null, dexAt: null, dexStatus: 'pending', qualified: false,
    klineStatus: 'skipped', rpsScores: emptyScores(), result: null };
}
