import { z } from 'zod';
import { canonicalCa } from '../addresses.js';
import { GmgnError, resolveGmgnChain, type GmgnClient } from '../api/gmgn.js';
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
const RECENT_BARS = 100;
const HISTORY_BARS = 96;
const IDLE_POLL_MS = 60_000;
const RETRY_MS = 30_000;
const BOUNDARY_BUFFER_MS = 1_000;
const MAX_RECENT_BURST = 4;
const MAX_PRIMARY_RECENT_BURST = 4;
const WARM_FAILURE_LIMIT = 3;
const stamp = z.number().int().nonnegative();
const aligned = stamp.refine((value) => value % STEP === 0);
const attemptSchema = z.object({ kind: z.enum(['recent', 'history']), from: aligned, to: aligned, at: stamp });
const assetSchema = z.object({
  network: z.string().min(1), chain: z.string().min(1), ca: z.string().min(1),
  order: stamp, recentOrder: stamp, historyOrder: stamp,
  admitted: z.boolean(), targetFrom: aligned.nullable(), historyTo: aligned.nullable(),
  historyComplete: z.boolean(), recentDueAt: stamp, recentRetryAt: stamp, historyDueAt: stamp,
  recentBoundary: aligned.nullable(), lastRecentAt: stamp.nullable(),
  deferUntil: stamp, failures: stamp, lastAttempt: attemptSchema.nullable(),
});
const stateSchema = z.object({ version: z.literal(1), sequence: stamp, nextAt: stamp,
  requests: stamp, recentRequests: stamp, historyRequests: stamp, recentBurst: stamp, primaryRecentBurst: stamp.default(0),
  assets: z.array(assetSchema),
}).refine((value) => new Set(value.assets.map((asset) => assetKey(asset.network, asset.ca))).size === value.assets.length)
  .refine((value) => value.assets.every((asset) => asset.ca === canonicalCa(asset.ca)
    && asset.network === asset.network.trim() && resolveGmgnChain(asset.chain) === asset.chain
    && resolveGmgnChain(asset.network) === asset.chain
    && (!asset.admitted || asset.targetFrom !== null)
    && (!asset.historyComplete || (asset.targetFrom !== null && asset.historyTo === asset.targetFrom))));
type State = z.infer<typeof stateSchema>;
type Asset = z.infer<typeof assetSchema>;
type Kind = 'recent' | 'history';
type Role = 'active' | 'new' | 'warm';
interface Member { network: string; chain: string; ca: string; role: Role }
interface Task { asset: Asset; member: Member; kind: Kind; from: number; to: number }

export interface GmgnCollectionStatus {
  status: 'running' | 'idle' | 'cooldown' | 'auth_error' | 'disabled';
  updatedAt: number;
  /** 逻辑请求任务数；client 的内部网络重试不另计，不能当作 HTTP 次数。 */
  requests: number; recentRequests: number; historyRequests: number;
  /** 查询完首次计划范围，不表示连续价格齐全；空/稀疏响应也可完成范围查询。 */
  assetsWithHistory: number;
  /** 已准入的当前成员中，仍未完成计划范围查询的个数；不含等待 warm 槽的候选。 */
  backfillPending: number;
  cooldownUntil: number;
  lastErrorCode: string | null;
}
export interface GmgnCollectionResult { attempted: boolean; nextAt: number; changed: boolean }
class CollectorError extends Error {
  constructor(readonly code: string) { super('GMGN 采集状态或行情校验失败'); }
}
const barSchema = z.object({
  openTime: aligned, open: z.number().finite().positive(), high: z.number().finite().positive(),
  low: z.number().finite().positive(), close: z.number().finite().positive(), volume: z.number().finite().nonnegative(),
}).refine((bar) => bar.high >= Math.max(bar.open, bar.close, bar.low) && bar.low <= Math.min(bar.open, bar.close));
const resultSchema = z.object({ source: z.object({ provider: z.literal('gmgn'), scope: z.literal('token'),
  chain: z.string(), ca: z.string(), currency: z.literal('usd'), pool: z.null() }), candles: z.array(barSchema) });
const cooldownSchema = z.object({ until: stamp });
const authSchema = z.object({ httpStatus: z.union([z.literal(401), z.literal(403)]), at: stamp });
function assetKey(network: string, ca: string): string { return JSON.stringify([network, canonicalCa(ca)]); }
function initialState(): State {
  return { version: 1, sequence: 0, nextAt: 0, requests: 0, recentRequests: 0, historyRequests: 0, recentBurst: 0, primaryRecentBurst: 0, assets: [] };
}
function sameBar(a: Candle, b: Candle): boolean {
  return a.openTime === b.openTime && a.open === b.open && a.high === b.high && a.low === b.low
    && a.close === b.close && a.volume === b.volume;
}

/** 单 owner、公平且可重启的 GMGN 近期/历史队列；不会激活或切换正式行情来源。 */
export function createGmgnCollector(opts: {
  db: StoreDatabase; cfg: StrategyConfig; client: Pick<GmgnClient, 'getCandles15m' | 'setRateLimitStore'>;
  clock?: () => number; log?: (message: string) => void;
}) {
  const { db, cfg, client } = opts;
  const clock = opts.clock ?? Date.now;
  const settings = cfg.kline.gmgn;
  const gapMs = Math.ceil(60_000 / settings.requestsPerMinute);
  const refreshMs = settings.refreshMinutes * 60_000;
  const key = strategyKey(cfg);
  const allowed = new Set(settings.chains.map(resolveGmgnChain).filter((chain) => chain !== null));
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
    } catch { /* 不让原始 JSON 或 schema 错误进入日志。 */ }
    throw new CollectorError('GMGN_STATE');
  }
  function write(name: string, value: unknown, now: number): void {
    put.run(name, JSON.stringify(value), now);
  }
  function saveState(state: State, now: number): void {
    const parsed = stateSchema.safeParse(state);
    if (!parsed.success) throw new CollectorError('GMGN_STATE');
    write('gmgn_state', parsed.data, now);
  }
  const cooldownStore: RateLimitStore = {
    getUntil: () => read('gmgn_cooldown', cooldownSchema)?.until ?? 0,
    setUntil: db.transaction((until: number) => {
      const value = cooldownSchema.safeParse({ until: Math.max(until, cooldownStore.getUntil()) });
      if (!value.success) throw new CollectorError('GMGN_STATE');
      write('gmgn_cooldown', value.data, clock());
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
      const chain = resolveGmgnChain(rawChain);
      if (!chain || !allowed.has(chain)) continue;
      const ca = canonicalCa(member.pool.ca.trim());
      if (!(chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca) : /^0x[\da-f]{40}$/.test(ca))) continue;
      const network = resolveGeckoNetwork(rawChain);
      const active = series.getActive(network, ca);
      if (active && !isSupportedMarketSeries(active)) continue;
      const role = !active ? 'new' : active.source === 'gmgn' ? 'active' : 'warm';
      result.set(assetKey(network, ca), { network, chain, ca, role });
    }
    return result;
  }
  function admit(state: State, asset: Asset, now: number): void {
    asset.admitted = true;
    if (asset.targetFrom === null) {
      const boundary = Math.floor(now / STEP) * STEP;
      asset.targetFrom = Math.max(0, boundary - cfg.kline.bars15m * STEP);
    }
    asset.deferUntil = 0;
    // 创建候选身份不等于激活；既有同身份历史会被复用。
    series.ensureSeries({ source: 'gmgn', scope: 'token', network: asset.network, ca: asset.ca,
      poolAddress: null, currency: 'usd', formatVersion: MARKET_SERIES_FORMAT_VERSION }, now);
  }
  function synchronize(state: State, current: Map<string, Member>, now: number): void {
    const byKey = new Map(state.assets.map((asset) => [assetKey(asset.network, asset.ca), asset]));
    for (const [id, member] of current) {
      let asset = byKey.get(id);
      if (!asset) {
        const order = ++state.sequence;
        asset = { network: member.network, chain: member.chain, ca: member.ca, order,
          recentOrder: order, historyOrder: order, admitted: false, targetFrom: null, historyTo: null,
          historyComplete: false, recentDueAt: 0, recentRetryAt: 0, historyDueAt: 0,
          recentBoundary: null, lastRecentAt: null, deferUntil: 0, failures: 0, lastAttempt: null };
        state.assets.push(asset); byKey.set(id, asset);
      }
      // 长期移出后再入池，近期单窗不足以填补中断；重新计划当前窗口，旧历史仍保留。
      if (asset.historyComplete && asset.lastRecentAt !== null && now - asset.lastRecentAt > RECENT_BARS * STEP) {
        asset.historyComplete = false; asset.historyTo = null;
        asset.targetFrom = Math.max(0, Math.floor(now / STEP) * STEP - cfg.kline.bars15m * STEP);
        asset.admitted = false; asset.recentBoundary = null; asset.recentDueAt = 0;
      }
      if (member.role !== 'warm' && !asset.admitted) admit(state, asset, now);
    }
    const warm = state.assets.filter((asset) => current.get(assetKey(asset.network, asset.ca))?.role === 'warm');
    const occupied = warm.filter((asset) => asset.admitted && !asset.historyComplete).sort((a, b) => a.order - b.order);
    for (const asset of occupied.slice(settings.warmupAssets)) asset.admitted = false;
    let slots = Math.min(occupied.length, settings.warmupAssets);
    for (const asset of warm.filter((asset) => !asset.admitted && asset.deferUntil <= now).sort((a, b) => a.order - b.order)) {
      if (slots >= settings.warmupAssets) break;
      admit(state, asset, now); slots++;
    }
  }
  function recentDue(asset: Asset): number {
    const boundary = asset.recentBoundary === null ? 0 : asset.recentBoundary + STEP + BOUNDARY_BUFFER_MS;
    return Math.max(asset.recentRetryAt, Math.min(asset.recentDueAt, boundary));
  }
  function eligible(state: State, current: Map<string, Member>): Array<{ asset: Asset; member: Member }> {
    return state.assets.flatMap((asset) => {
      const member = current.get(assetKey(asset.network, asset.ca));
      return member && asset.admitted ? [{ asset, member }] : [];
    });
  }
  function choose(state: State, current: Map<string, Member>, now: number): Task | null {
    const all = eligible(state, current);
    const recent = all.filter(({ asset }) => recentDue(asset) <= now).sort((a, b) => {
      const priority = (entry: typeof a) => (entry.asset.recentBoundary === null ? 0 : 2) + (entry.member.role === 'warm' ? 1 : 0);
      return priority(a) - priority(b) || a.asset.recentOrder - b.asset.recentOrder;
    });
    const history = all.filter(({ asset }) => !asset.historyComplete && asset.historyTo !== null && asset.historyDueAt <= now)
      .sort((a, b) => a.asset.historyOrder - b.asset.historyOrder);
    // primary保留近期的大多数份额；每最多4次primary近期后给一个due warm，防止候选永远缺新端点。
    const warm = recent.filter(({ member }) => member.role === 'warm').sort((a, b) => a.asset.recentOrder - b.asset.recentOrder)[0];
    const first = warm && state.primaryRecentBurst >= MAX_PRIMARY_RECENT_BURST ? warm : recent[0];
    const historical = history[0];
    if (historical && (!first || state.recentBurst >= MAX_RECENT_BURST)) {
      const to = historical.asset.historyTo!;
      return { ...historical, kind: 'history', from: Math.max(historical.asset.targetFrom!, to - HISTORY_BARS * STEP), to };
    }
    if (first) {
      const to = Math.floor(now / STEP) * STEP;
      if (to === 0) return null;
      return { ...first, kind: 'recent', from: Math.max(0, to - RECENT_BARS * STEP), to };
    }
    return null;
  }
  function nextDue(state: State, current: Map<string, Member>, now: number): number {
    const all = eligible(state, current);
    const times = all.flatMap(({ asset }) => [recentDue(asset),
      ...(!asset.historyComplete && asset.historyTo !== null ? [asset.historyDueAt] : [])]);
    for (const asset of state.assets) {
      if (current.has(assetKey(asset.network, asset.ca)) && !asset.admitted && asset.deferUntil > now) times.push(asset.deferUntil);
    }
    const due = times.length ? Math.min(...times) : now + IDLE_POLL_MS;
    return Math.max(now + gapMs, state.nextAt, Math.min(due, now + IDLE_POLL_MS));
  }
  function publish(state: State, current: Map<string, Member>, status: GmgnCollectionStatus['status'],
    now: number, lastErrorCode: string | null = null): void {
    const all = eligible(state, current);
    const value: GmgnCollectionStatus = { status, updatedAt: now,
      requests: state.requests, recentRequests: state.recentRequests, historyRequests: state.historyRequests,
      assetsWithHistory: all.filter(({ asset }) => asset.historyComplete).length,
      backfillPending: all.filter(({ asset }) => !asset.historyComplete).length,
      cooldownUntil: cooldownStore.getUntil(), lastErrorCode };
    write('gmgn_status', value, now);
  }
  function checkedBars(raw: unknown, task: Task, requestedAt: number, receivedAt: number): Candle[] {
    const result = resultSchema.safeParse(raw);
    if (!result.success) throw new CollectorError('GMGN_VALIDATION');
    const { source, candles } = result.data;
    if (source.chain !== task.member.chain || canonicalCa(source.ca) !== task.member.ca) throw new CollectorError('GMGN_IDENTITY');
    const byTime = new Map<number, Candle>();
    for (const bar of candles) {
      const previous = byTime.get(bar.openTime);
      if (previous && !sameBar(previous, bar)) throw new CollectorError('GMGN_VALIDATION');
      byTime.set(bar.openTime, bar);
    }
    return [...byTime.values()].filter((bar) => bar.openTime >= task.from && bar.openTime < task.to
      && bar.openTime + STEP <= Math.min(requestedAt, receivedAt, task.to)).sort((a, b) => a.openTime - b.openTime);
  }
  function writeBars(task: Task, bars: Candle[], now: number): boolean {
    const identity = series.getTokenSeries(task.member.network, task.member.ca);
    if (!identity || !isSupportedMarketSeries(identity) || identity.source !== 'gmgn' || identity.scope !== 'token'
      || identity.poolAddress !== null || identity.network !== task.member.network || identity.ca !== task.member.ca) {
      throw new CollectorError('GMGN_IDENTITY');
    }
    const existing = series.getCandles(identity.id, '15m');
    const old = new Map(existing.map((bar) => [bar.openTime, bar]));
    const changed = bars.some((bar) => !old.has(bar.openTime) || !sameBar(old.get(bar.openTime)!, bar));
    if (changed) {
      series.upsertCandles(identity.id, '15m', bars);
      const accumulated = series.getCandles(identity.id, '15m').filter((bar) => bar.openTime + STEP <= now).reverse();
      series.upsertCandles(identity.id, '1h', aggregateCandles(accumulated, STEP, INTERVAL_MS['1h']));
      series.upsertCandles(identity.id, '4h', aggregateCandles(accumulated, STEP, INTERVAL_MS['4h']));
    }
    return changed;
  }
  function errorCode(error: unknown): string {
    if (error instanceof GmgnError) return error.code;
    if (error instanceof CollectorError) return error.code;
    return 'GMGN_COLLECTION';
  }
  function logFailure(code: string): void {
    try { opts.log?.('GMGN collector: ' + code); } catch { /* 日志失败不影响采集状态。 */ }
  }

  return {
    /** 已发出的HTTP由client超时结束；stop后忽略响应，调用方等待循环退出再关闭DB。 */
    stop(): void { stopped = true; },
    async collectOnce(now = clock()): Promise<GmgnCollectionResult | null> {
      if (busy || stopped) return null;
      busy = true;
      let state: State | null = null;
      let current = new Map<string, Member>();
      let task: Task | null = null;
      let attempted = false;
      try {
        if (!Number.isSafeInteger(now) || now < 0) throw new CollectorError('GMGN_STATE');
        state = read('gmgn_state', stateSchema) ?? initialState();
        current = members();
        if (!settings.enabled) {
          publish(state, current, 'disabled', now);
          return { attempted: false, nextAt: now + IDLE_POLL_MS, changed: false };
        }
        if (read('gmgn_auth_error', authSchema)) {
          publish(state, current, 'auth_error', now, 'GMGN_AUTH');
          return { attempted: false, nextAt: now + IDLE_POLL_MS, changed: false };
        }
        const cooldown = cooldownStore.getUntil();
        if (cooldown > now) {
          publish(state, current, 'cooldown', now, 'GMGN_RATE_LIMIT');
          return { attempted: false, nextAt: cooldown, changed: false };
        }
        db.transaction(() => { synchronize(state!, current, now); saveState(state!, now); })();
        if (state.nextAt > now || !(task = choose(state, current, now))) {
          publish(state, current, 'idle', now);
          return { attempted: false, nextAt: Math.max(state.nextAt, nextDue(state, current, now)), changed: false };
        }
        const asset = task.asset;
        // 请求前持久化attempt与FIFO顺序；失败或进程退出不能把队首固定在同一个CA。
        asset.lastAttempt = { kind: task.kind, from: task.from, to: task.to, at: now };
        if (task.kind === 'recent') {
          asset.recentOrder = ++state.sequence;
          asset.recentBoundary = task.to;
          asset.recentRetryAt = now + RETRY_MS;
          state.recentRequests++; state.recentBurst++;
          state.primaryRecentBurst = task.member.role === 'warm' ? 0 : Math.min(MAX_PRIMARY_RECENT_BURST, state.primaryRecentBurst + 1);
        } else {
          asset.historyOrder = ++state.sequence;
          asset.historyDueAt = now + RETRY_MS;
          state.historyRequests++; state.recentBurst = 0;
        }
        state.requests++; state.nextAt = now + gapMs;
        db.transaction(() => { saveState(state!, now); publish(state!, current, 'running', now); })();
        attempted = true;
        const raw = await client.getCandles15m(task.member.chain, task.member.ca, { from: task.from, to: task.to });
        if (stopped) return null;
        const receivedAt = clock();
        const bars = checkedBars(raw, task, now, receivedAt);
        // 在途期间名单可能更新，只读取最新名单，不写回旧 observation/评分快照。
        current = members();
        state.nextAt = Math.max(state.nextAt, receivedAt + gapMs);
        let changed = false;
        db.transaction(() => {
          if (current.has(assetKey(task!.member.network, task!.member.ca))) {
            changed = writeBars(task!, bars, receivedAt);
            asset.failures = 0;
            if (task!.kind === 'recent') {
              asset.lastRecentAt = receivedAt; asset.recentRetryAt = 0;
              asset.recentDueAt = receivedAt + refreshMs * (task!.member.role === 'warm' && asset.historyComplete ? 3 : 1);
              if (asset.historyTo === null) {
                const seed = bars[0]?.openTime ?? task!.from;
                asset.historyTo = seed <= asset.targetFrom! ? asset.targetFrom : seed + STEP;
                asset.historyComplete = asset.historyTo === asset.targetFrom;
                asset.historyDueAt = receivedAt;
              }
            } else {
              // 成功查询空/稀疏窗口也推进边界。相邻页重叠1根，绝不补造缺失价格。
              asset.historyComplete = task!.from <= asset.targetFrom!;
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
          write('gmgn_status', { status: 'idle', updatedAt: at, requests: 0, recentRequests: 0, historyRequests: 0,
            assetsWithHistory: 0, backfillPending: 0, cooldownUntil: 0, lastErrorCode: code }, at);
          return { attempted, nextAt: at + IDLE_POLL_MS, changed: false };
        }
        state.nextAt = Math.max(state.nextAt, at + gapMs);
        let status: GmgnCollectionStatus['status'] = 'idle';
        let nextAt = at + gapMs;
        if (error instanceof GmgnError && (error.httpStatus === 401 || error.httpStatus === 403)) {
          write('gmgn_auth_error', { httpStatus: error.httpStatus, at }, at);
          status = 'auth_error'; nextAt = at + IDLE_POLL_MS;
        } else if (error instanceof GmgnError && (error.code === 'GMGN_RATE_LIMIT' || error.httpStatus === 429)) {
          const until = error.retryAt !== undefined && Number.isSafeInteger(error.retryAt) && error.retryAt > at
            ? error.retryAt : at + IDLE_POLL_MS;
          cooldownStore.setUntil(until);
          status = 'cooldown'; nextAt = cooldownStore.getUntil();
        } else if (task) {
          task.asset.failures++;
          if (task.kind === 'recent') task.asset.recentRetryAt = at + RETRY_MS;
          else task.asset.historyDueAt = at + RETRY_MS;
          if (task.member.role === 'warm' && !task.asset.historyComplete && task.asset.failures >= WARM_FAILURE_LIMIT) {
            task.asset.admitted = false; task.asset.deferUntil = at + refreshMs * 6;
            task.asset.order = ++state.sequence; task.asset.failures = 0;
          }
        } else nextAt = at + IDLE_POLL_MS;
        saveState(state, at);
        // 状态只包含固定错误码，不包含CA/原始响应/headers；pool成员数每次重新读取。
        current = members();
        publish(state, current, status, at, code);
        return { attempted, nextAt, changed: false };
      } finally { busy = false; }
    },
  };
}
