import { z } from 'zod';
import { canonicalCa } from '../addresses.js';
import { BinanceWeb3Error, resolveBinanceChain, type BinanceWeb3Client } from '../api/binance-web3.js';
import { resolveGeckoNetwork } from '../api/networks.js';
import type { RateLimitStore } from '../api/erwa.js';
import type { StrategyConfig } from '../config/strategy.js';
import { aggregateCandles } from '../indicators/merge.js';
import { INTERVAL_MS } from '../market.js';
import type { StoreDatabase } from '../store/db.js';
import { createRuntimeStore, strategyKey } from '../store/runtime.js';
import { createSeriesStore, isSupportedMarketSeries, MARKET_SERIES_FORMAT_VERSION } from '../store/series.js';
import type { Candle } from '../types.js';

const STEP = INTERVAL_MS['15m'];
/** 单页上限 300，留一根重叠余量，避免跨页丢首根。 */
const RECENT_BARS = 280;
const HISTORY_BARS = 280;
const IDLE_POLL_MS = 60_000;
const RETRY_MS = 30_000;
const BOUNDARY_BUFFER_MS = 1_000;
/** 连续多少次近期请求后，必须让一个到期的历史回补插队。 */
const MAX_RECENT_BURST = 4;
const SOURCE = 'binance' as const;

const stamp = z.number().int().nonnegative();
const aligned = stamp.refine((value) => value % STEP === 0);
const attemptSchema = z.object({ kind: z.enum(['recent', 'history']), from: aligned, to: aligned, at: stamp });
const assetSchema = z.object({
  network: z.string().min(1), ca: z.string().min(1),
  order: stamp, recentOrder: stamp, historyOrder: stamp,
  targetFrom: aligned.nullable(), historyTo: aligned.nullable(), historyComplete: z.boolean(),
  recentDueAt: stamp, recentRetryAt: stamp, historyDueAt: stamp,
  recentBoundary: aligned.nullable(), lastRecentAt: stamp.nullable(), failures: stamp,
  lastAttempt: attemptSchema.nullable(),
});
const stateSchema = z.object({
  version: z.literal(1), sequence: stamp, nextAt: stamp,
  requests: stamp, recentRequests: stamp, historyRequests: stamp, recentBurst: stamp.default(0),
  assets: z.array(assetSchema),
}).refine((value) => new Set(value.assets.map((asset) => assetKey(asset.network, asset.ca))).size === value.assets.length)
  .refine((value) => value.assets.every((asset) => asset.ca === canonicalCa(asset.ca)
    && asset.network === asset.network.trim() && resolveBinanceChain(asset.network) !== null
    && (!asset.historyComplete || (asset.targetFrom !== null && asset.historyTo === asset.targetFrom))));
type State = z.infer<typeof stateSchema>;
type Asset = z.infer<typeof assetSchema>;
type Kind = 'recent' | 'history';
interface Member { network: string; ca: string }
interface Task { asset: Asset; member: Member; kind: Kind; from: number; to: number }

export interface BinanceCollectionStatus {
  status: 'running' | 'idle' | 'cooldown' | 'auth_error' | 'disabled';
  updatedAt: number;
  /** 逻辑请求任务数；client 内部的翻页与网络重试不另计。 */
  requests: number; recentRequests: number; historyRequests: number;
  /** 已查询完首次计划范围的成员数；不代表价格连续，稀疏响应同样算完成。 */
  assetsWithHistory: number;
  backfillPending: number;
  cooldownUntil: number;
  lastErrorCode: string | null;
}
export interface BinanceCollectionResult { attempted: boolean; nextAt: number; changed: boolean }

class CollectorError extends Error {
  constructor(readonly code: string) { super('Binance Web3 采集状态或行情校验失败'); }
}

const barSchema = z.object({
  openTime: aligned, open: z.number().finite().positive(), high: z.number().finite().positive(),
  low: z.number().finite().positive(), close: z.number().finite().positive(), volume: z.number().finite().nonnegative(),
}).refine((bar) => bar.high >= Math.max(bar.open, bar.close, bar.low) && bar.low <= Math.min(bar.open, bar.close));
const resultSchema = z.object({
  source: z.object({ provider: z.literal('binance'), scope: z.literal('token'), chain: z.string(),
    ca: z.string(), currency: z.literal('usd'), pool: z.null() }),
  candles: z.array(barSchema),
  exhausted: z.boolean(),
});
const cooldownSchema = z.object({ until: stamp });
const authSchema = z.object({ httpStatus: z.union([z.literal(401), z.literal(403)]), at: stamp });

function assetKey(network: string, ca: string): string { return JSON.stringify([network, canonicalCa(ca)]); }
function initialState(): State {
  return { version: 1, sequence: 0, nextAt: 0, requests: 0, recentRequests: 0, historyRequests: 0,
    recentBurst: 0, assets: [] };
}
function sameBar(a: Candle, b: Candle): boolean {
  return a.openTime === b.openTime && a.open === b.open && a.high === b.high && a.low === b.low
    && a.close === b.close && a.volume === b.volume;
}

/**
 * 单 owner、公平轮转的 Binance Web3 近期/历史队列。
 * 只写入自己的 token 序列候选身份，绝不激活、绝不改动其他来源的活跃序列。
 */
export function createBinanceCollector(opts: {
  db: StoreDatabase; cfg: StrategyConfig;
  client: Pick<BinanceWeb3Client, 'getCandles15m' | 'setRateLimitStore'>;
  clock?: () => number; log?: (message: string) => void;
}) {
  const { db, cfg, client } = opts;
  const clock = opts.clock ?? Date.now;
  const settings = cfg.kline.binance;
  const gapMs = Math.ceil(60_000 / settings.requestsPerMinute);
  const refreshMs = settings.refreshMinutes * 60_000;
  const historyMs = settings.historyDays * 86_400_000;
  const key = strategyKey(cfg);
  // 链名按 binanceChainId 归一，'ethereum' 与 'eth' 视为同一条链。
  const allowed = new Set(settings.chains.map(resolveBinanceChain).filter((id): id is string => id !== null));
  const runtime = createRuntimeStore(db, clock);
  const series = createSeriesStore(db);
  const select = db.prepare('SELECT payload FROM runtime_state WHERE key = ?');
  const put = db.prepare('INSERT INTO runtime_state (key,payload,updated_at) VALUES (?,?,?) '
    + 'ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at');
  let busy = false;
  let stopped = false;

  function read<T>(name: string, schema: z.ZodType<T>): T | null {
    const row = select.get(name) as { payload: string } | undefined;
    if (!row) return null;
    try {
      const parsed = schema.safeParse(JSON.parse(row.payload));
      if (parsed.success) return parsed.data;
    } catch { /* 原始 JSON 与 schema 细节不得进入日志。 */ }
    throw new CollectorError('BINANCE_STATE');
  }
  function write(name: string, value: unknown, now: number): void {
    put.run(name, JSON.stringify(value), now);
  }
  function saveState(state: State, now: number): void {
    const parsed = stateSchema.safeParse(state);
    if (!parsed.success) throw new CollectorError('BINANCE_STATE');
    write('binance_state', parsed.data, now);
  }
  const cooldownStore: RateLimitStore = {
    getUntil: () => read('binance_cooldown', cooldownSchema)?.until ?? 0,
    setUntil: db.transaction((until: number) => {
      const value = cooldownSchema.safeParse({ until: Math.max(until, cooldownStore.getUntil()) });
      if (!value.success) throw new CollectorError('BINANCE_STATE');
      write('binance_cooldown', value.data, clock());
    }),
  };
  client.setRateLimitStore(cooldownStore);

  function members(): Map<string, Member> {
    const observed = runtime.getObservationRound();
    const result = new Map<string, Member>();
    if (!observed?.boardComplete || observed.strategyKey !== key) return result;
    for (const member of observed.members) {
      const rawChain = member.pool.chain ?? member.dex?.chainId;
      if (!rawChain) continue;
      const network = resolveGeckoNetwork(rawChain);
      const chainId = resolveBinanceChain(network);
      if (!chainId || !allowed.has(chainId)) continue;
      const ca = canonicalCa(member.pool.ca.trim());
      // 地址形态必须与链匹配，残缺地址不得占用请求预算。
      if (!(chainId === 'CT_501' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca) : /^0x[\da-f]{40}$/.test(ca))) continue;
      const active = series.getActive(network, ca);
      if (active && !isSupportedMarketSeries(active)) continue;
      result.set(assetKey(network, ca), { network, ca });
    }
    return result;
  }
  function admit(asset: Asset, now: number): void {
    if (asset.targetFrom === null) {
      const boundary = Math.floor(now / STEP) * STEP;
      asset.targetFrom = Math.max(0, boundary - Math.ceil(historyMs / STEP) * STEP);
    }
    // 创建候选身份不等于激活；同身份的既有历史会被复用。
    series.ensureSeries({ source: SOURCE, scope: 'token', network: asset.network, ca: asset.ca,
      poolAddress: null, currency: 'usd', formatVersion: MARKET_SERIES_FORMAT_VERSION }, now);
  }
  function synchronize(state: State, current: Map<string, Member>, now: number): void {
    const byKey = new Map(state.assets.map((asset) => [assetKey(asset.network, asset.ca), asset]));
    for (const [id, member] of current) {
      let asset = byKey.get(id);
      if (!asset) {
        const order = ++state.sequence;
        asset = { network: member.network, ca: member.ca, order, recentOrder: order, historyOrder: order,
          targetFrom: null, historyTo: null, historyComplete: false, recentDueAt: 0, recentRetryAt: 0,
          historyDueAt: 0, recentBoundary: null, lastRecentAt: null, failures: 0, lastAttempt: null };
        state.assets.push(asset); byKey.set(id, asset);
      }
      // 长期离池再回来时，单个近期窗口补不回中断；重新规划当前窗口，旧历史保留。
      if (asset.historyComplete && asset.lastRecentAt !== null && now - asset.lastRecentAt > RECENT_BARS * STEP) {
        asset.historyComplete = false; asset.historyTo = null; asset.targetFrom = null;
        asset.recentBoundary = null; asset.recentDueAt = 0;
      }
      admit(asset, now);
    }
  }
  function recentDue(asset: Asset): number {
    const boundary = asset.recentBoundary === null ? 0 : asset.recentBoundary + STEP + BOUNDARY_BUFFER_MS;
    return Math.max(asset.recentRetryAt, Math.min(asset.recentDueAt, boundary));
  }
  function eligible(state: State, current: Map<string, Member>): Array<{ asset: Asset; member: Member }> {
    return state.assets.flatMap((asset) => {
      const member = current.get(assetKey(asset.network, asset.ca));
      return member ? [{ asset, member }] : [];
    });
  }
  function choose(state: State, current: Map<string, Member>, now: number): Task | null {
    const all = eligible(state, current);
    // 近期端点优先：评分要求每个成员在基准 T 之后被刷到。
    const recent = all.filter(({ asset }) => recentDue(asset) <= now)
      .sort((a, b) => a.asset.recentOrder - b.asset.recentOrder)[0];
    const history = all.filter(({ asset }) => !asset.historyComplete && asset.historyTo !== null
      && asset.historyDueAt <= now).sort((a, b) => a.asset.historyOrder - b.asset.historyOrder)[0];
    // 刷新需求高于吞吐时近期队列永不为空，必须按配比让出名额，
    // 否则历史永远补不满、候选永远达不到切源门槛。
    if (history && (!recent || state.recentBurst >= MAX_RECENT_BURST)) {
      const to = history.asset.historyTo!;
      return { ...history, kind: 'history', from: Math.max(history.asset.targetFrom!, to - HISTORY_BARS * STEP), to };
    }
    if (recent) {
      const to = Math.floor(now / STEP) * STEP;
      if (to === 0) return null;
      return { ...recent, kind: 'recent', from: Math.max(0, to - RECENT_BARS * STEP), to };
    }
    return null;
  }
  function nextDue(state: State, current: Map<string, Member>, now: number): number {
    const all = eligible(state, current);
    const times = all.flatMap(({ asset }) => [recentDue(asset),
      ...(!asset.historyComplete && asset.historyTo !== null ? [asset.historyDueAt] : [])]);
    const due = times.length ? Math.min(...times) : now + IDLE_POLL_MS;
    return Math.max(now + gapMs, state.nextAt, Math.min(due, now + IDLE_POLL_MS));
  }
  function publish(state: State, current: Map<string, Member>, status: BinanceCollectionStatus['status'],
    now: number, lastErrorCode: string | null = null): void {
    const all = eligible(state, current);
    const value: BinanceCollectionStatus = { status, updatedAt: now,
      requests: state.requests, recentRequests: state.recentRequests, historyRequests: state.historyRequests,
      assetsWithHistory: all.filter(({ asset }) => asset.historyComplete).length,
      backfillPending: all.filter(({ asset }) => !asset.historyComplete).length,
      cooldownUntil: cooldownStore.getUntil(), lastErrorCode };
    write('binance_status', value, now);
  }
  function checkedBars(raw: unknown, task: Task, requestedAt: number, receivedAt: number): { bars: Candle[]; exhausted: boolean } {
    const parsed = resultSchema.safeParse(raw);
    if (!parsed.success) throw new CollectorError('BINANCE_VALIDATION');
    const { source, candles, exhausted } = parsed.data;
    if (source.chain !== task.member.network || canonicalCa(source.ca) !== task.member.ca) {
      throw new CollectorError('BINANCE_IDENTITY');
    }
    const byTime = new Map<number, Candle>();
    for (const bar of candles) {
      const previous = byTime.get(bar.openTime);
      if (previous && !sameBar(previous, bar)) throw new CollectorError('BINANCE_VALIDATION');
      byTime.set(bar.openTime, bar);
    }
    const bars = [...byTime.values()].filter((bar) => bar.openTime >= task.from && bar.openTime < task.to
      && bar.openTime + STEP <= Math.min(requestedAt, receivedAt, task.to)).sort((a, b) => a.openTime - b.openTime);
    return { bars, exhausted };
  }
  function writeBars(task: Task, bars: Candle[], now: number): boolean {
    const identity = series.getTokenSeries(task.member.network, task.member.ca, SOURCE);
    if (!identity || !isSupportedMarketSeries(identity) || identity.source !== SOURCE || identity.scope !== 'token'
      || identity.poolAddress !== null || identity.network !== task.member.network || identity.ca !== task.member.ca) {
      throw new CollectorError('BINANCE_IDENTITY');
    }
    const existing = series.getCandles(identity.id, '15m');
    const old = new Map(existing.map((bar) => [bar.openTime, bar]));
    const changed = bars.some((bar) => !old.has(bar.openTime) || !sameBar(old.get(bar.openTime)!, bar));
    if (changed) {
      series.upsertCandles(identity.id, '15m', bars);
      // 只用本序列累积的 15m 合成，绝不与 Gecko 的 pool 序列拼接。
      const accumulated = series.getCandles(identity.id, '15m').filter((bar) => bar.openTime + STEP <= now).reverse();
      series.upsertCandles(identity.id, '1h', aggregateCandles(accumulated, STEP, INTERVAL_MS['1h']));
      series.upsertCandles(identity.id, '4h', aggregateCandles(accumulated, STEP, INTERVAL_MS['4h']));
    }
    return changed;
  }
  function errorCode(error: unknown): string {
    if (error instanceof BinanceWeb3Error) return error.code;
    if (error instanceof CollectorError) return error.code;
    return 'BINANCE_COLLECTION';
  }
  function logFailure(code: string): void {
    try { opts.log?.('Binance collector: ' + code); } catch { /* 日志失败不影响采集。 */ }
  }

  return {
    /** 已发出的 HTTP 由 client 超时结束；stop 后忽略响应，调用方等循环退出再关库。 */
    stop(): void { stopped = true; },
    async collectOnce(now = clock()): Promise<BinanceCollectionResult | null> {
      if (busy || stopped) return null;
      busy = true;
      let state: State | null = null;
      let current = new Map<string, Member>();
      let task: Task | null = null;
      let attempted = false;
      try {
        if (!Number.isSafeInteger(now) || now < 0) throw new CollectorError('BINANCE_STATE');
        state = read('binance_state', stateSchema) ?? initialState();
        current = members();
        if (!settings.enabled) {
          publish(state, current, 'disabled', now);
          return { attempted: false, nextAt: now + IDLE_POLL_MS, changed: false };
        }
        if (read('binance_auth_error', authSchema)) {
          publish(state, current, 'auth_error', now, 'BINANCE_AUTH');
          return { attempted: false, nextAt: now + IDLE_POLL_MS, changed: false };
        }
        const cooldown = cooldownStore.getUntil();
        if (cooldown > now) {
          publish(state, current, 'cooldown', now, 'BINANCE_RATE_LIMIT');
          return { attempted: false, nextAt: cooldown, changed: false };
        }
        db.transaction(() => { synchronize(state!, current, now); saveState(state!, now); })();
        if (state.nextAt > now || !(task = choose(state, current, now))) {
          publish(state, current, 'idle', now);
          return { attempted: false, nextAt: Math.max(state.nextAt, nextDue(state, current, now)), changed: false };
        }
        const asset = task.asset;
        // 请求前先持久化顺序与 attempt；失败或进程退出都不能把队首钉死在同一个 CA。
        asset.lastAttempt = { kind: task.kind, from: task.from, to: task.to, at: now };
        if (task.kind === 'recent') {
          asset.recentOrder = ++state.sequence;
          asset.recentBoundary = task.to;
          asset.recentRetryAt = now + RETRY_MS;
          state.recentRequests++; state.recentBurst++;
        } else {
          asset.historyOrder = ++state.sequence;
          asset.historyDueAt = now + RETRY_MS;
          state.historyRequests++; state.recentBurst = 0;
        }
        state.requests++; state.nextAt = now + gapMs;
        db.transaction(() => { saveState(state!, now); publish(state!, current, 'running', now); })();
        attempted = true;
        const raw = await client.getCandles15m(task.member.network, task.member.ca, { from: task.from, to: task.to });
        if (stopped) return null;
        const receivedAt = clock();
        const { bars, exhausted } = checkedBars(raw, task, now, receivedAt);
        // 在途期间名单可能已更新，只读最新名单，不写回旧快照。
        current = members();
        state.nextAt = Math.max(state.nextAt, receivedAt + gapMs);
        let changed = false;
        db.transaction(() => {
          if (current.has(assetKey(task!.member.network, task!.member.ca))) {
            changed = writeBars(task!, bars, receivedAt);
            asset.failures = 0;
            if (task!.kind === 'recent') {
              asset.lastRecentAt = receivedAt; asset.recentRetryAt = 0;
              asset.recentDueAt = receivedAt + refreshMs;
              if (asset.historyTo === null) {
                const seed = bars[0]?.openTime ?? task!.from;
                asset.historyTo = seed <= asset.targetFrom! ? asset.targetFrom : seed + STEP;
                asset.historyComplete = asset.historyTo === asset.targetFrom;
                asset.historyDueAt = receivedAt;
              }
            } else {
              // 上游已到最早可得数据，或窗口已抵达计划起点，都算回补完成。
              asset.historyComplete = exhausted || task!.from <= asset.targetFrom!;
              asset.historyTo = asset.historyComplete ? asset.targetFrom : task!.from + STEP;
              asset.historyDueAt = receivedAt;
            }
          }
          saveState(state!, receivedAt); publish(state!, current, 'idle', receivedAt);
        })();
        return { attempted: true, nextAt: nextDue(state, current, receivedAt), changed };
      } catch (error) {
        if (stopped) return null;
        const at = Math.max(now, clock());
        const code = errorCode(error);
        logFailure(code);
        if (!state) {
          write('binance_status', { status: 'idle', updatedAt: at, requests: 0, recentRequests: 0, historyRequests: 0,
            assetsWithHistory: 0, backfillPending: 0, cooldownUntil: 0, lastErrorCode: code }, at);
          return { attempted, nextAt: at + IDLE_POLL_MS, changed: false };
        }
        state.nextAt = Math.max(state.nextAt, at + gapMs);
        let status: BinanceCollectionStatus['status'] = 'idle';
        let nextAt = at + gapMs;
        if (error instanceof BinanceWeb3Error && (error.httpStatus === 401 || error.httpStatus === 403)) {
          write('binance_auth_error', { httpStatus: error.httpStatus, at }, at);
          status = 'auth_error'; nextAt = at + IDLE_POLL_MS;
        } else if (error instanceof BinanceWeb3Error && (error.code === 'BINANCE_RATE_LIMIT' || error.httpStatus === 429)) {
          const until = error.retryAt !== undefined && Number.isSafeInteger(error.retryAt) && error.retryAt > at
            ? error.retryAt : at + IDLE_POLL_MS;
          cooldownStore.setUntil(until);
          status = 'cooldown'; nextAt = cooldownStore.getUntil();
        } else if (task) {
          task.asset.failures++;
          if (task.kind === 'recent') task.asset.recentRetryAt = at + RETRY_MS;
          else task.asset.historyDueAt = at + RETRY_MS;
        } else nextAt = at + IDLE_POLL_MS;
        saveState(state, at);
        // 状态只写固定错误码，不含 CA、原始响应或 headers。
        current = members();
        publish(state, current, status, at, code);
        return { attempted, nextAt, changed: false };
      } finally { busy = false; }
    },
  };
}
