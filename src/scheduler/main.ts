import cron from 'node-cron';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canonicalCa, isQueryableCa } from '../addresses.js';
import { DexScreenerClient } from '../api/dexscreener.js';
import { resolveGeckoNetwork } from '../api/networks.js';
import { GeckoTerminalClient, GeckoTerminalError } from '../api/geckoterminal.js';
import { GmgnClient, resolveGmgnChain } from '../api/gmgn.js';
import { ErwaClient, ErwaError } from '../api/erwa.js';
import { loadStrategy, StrategyConfigError, type StrategyConfig } from '../config/strategy.js';
import { calculateObservationRps, emptyBounds } from '../indicators/observation-rps.js';
import { HOUR_MS, INTERVAL_MS, MINUTE_MS, PERIODS, PERIOD_MS, RPS_KEYS, closedCandles, contiguousTail, emptyScores } from '../market.js';
import { aggregateCandles } from '../indicators/merge.js';
import { rsi } from '../indicators/rsi.js';
import { sma } from '../indicators/sma.js';
import { createNotifier, TelegramClient, TelegramError, type Notification } from '../notify/telegram.js';
import { PoolSelectionError, selectObservationPool } from '../pool/select.js';
import { evaluate, type RuleOutput } from '../rules/evaluate.js';
import { checkPreconditions } from '../rules/preconditions.js';
import { createCandleStore } from '../store/candles.js';
import { openDatabase, type StoreDatabase } from '../store/db.js';
import { createMomentStore } from '../store/moments.js';
import { createSeriesStore, isSupportedMarketSeries, MARKET_SERIES_FORMAT_VERSION, MarketSeriesError, type MarketSeries } from '../store/series.js';
import { createOutcomeStore } from '../store/outcomes.js';
import { createPoolStore } from '../store/pool.js';
import { createRuntimeStore, initialRound, pendingMember, RuntimeStateError, strategyKey, type RoundMember, type RoundSnapshot } from '../store/runtime.js';
import { readRoundInputs } from '../store/snapshot.js';
import type { BoardPoolItem, DexSnapshot, Range } from '../types.js';
import { createQuotaGuard, QuotaStopError } from './quota.js';
import { createGmgnCollector } from './gmgn.js';
import { gmgnReadiness, type SeriesHistory } from './gmgn-readiness.js';
import { createCalculationCoordinator } from './calculation-coordinator.js';

type DataClient = Pick<ErwaClient, 'getBoardSummary' | 'getDexScreener' | 'getKline' | 'getTokenUsage'>
  & Partial<Pick<ErwaClient, 'setRateLimitStore'>>;
type QuotaGuard = ReturnType<typeof createQuotaGuard>;
type Notifier = ReturnType<typeof createNotifier>;
export interface RoundReport {
  now: number; poolSize: number; candidateCount: number; poolComplete: boolean; failures: number; degraded: boolean; halted: boolean;
  results: { ca: string; result: RuleOutput }[];
}

/** 只持久化凭据摘要；普通重启不清除认证暂停，更换凭据后才解除。 */
export function configureGmgnAccess(db: StoreDatabase, enabled: boolean, apiKey: string | undefined, now: number): boolean {
  const put = db.prepare(`INSERT INTO runtime_state (key,payload,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`);
  const read = (key: string): Record<string, unknown> | null => {
    try {
      const row = db.prepare('SELECT payload FROM runtime_state WHERE key=?').get(key) as { payload: string } | undefined;
      const value: unknown = row ? JSON.parse(row.payload) : null;
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch { return null; }
  };
  if (!enabled || !apiKey || !/^[\x21-\x7e]+$/.test(apiKey)) {
    const previous = read('gmgn_status');
    const counters = Object.fromEntries(['requests', 'recentRequests', 'historyRequests', 'assetsWithHistory', 'backfillPending', 'cooldownUntil']
      .map((key) => [key, typeof previous?.[key] === 'number' && Number.isSafeInteger(previous[key]) && previous[key] >= 0 ? previous[key] : 0]));
    put.run('gmgn_status', JSON.stringify({ ...counters, status: 'disabled', updatedAt: now,
      lastErrorCode: enabled ? 'GMGN_INPUT' : null, reason: !enabled ? 'configuration_disabled' : !apiKey ? 'missing_api_key' : 'invalid_api_key' }), now);
    return false;
  }
  const fingerprint = createHash('sha256').update(apiKey).digest('hex');
  db.transaction(() => {
    const previous = read('gmgn_credential');
    if (typeof previous?.fingerprint === 'string' && previous.fingerprint !== fingerprint) {
      db.prepare("DELETE FROM runtime_state WHERE key='gmgn_auth_error'").run();
    }
    put.run('gmgn_credential', JSON.stringify({ fingerprint }), now);
  })();
  return true;
}

/** GMGN 按自己的 nextAt 前进；只报告数据更新，重算频率由两源共享协调器控制。 */
export async function runGmgnCollectionLoop(opts: {
  collector: Pick<ReturnType<typeof createGmgnCollector>, 'collectOnce'>;
  intervalMs: number; clock: () => number; stopped: () => boolean; sleep: (ms: number) => Promise<void>;
  requestCalculation: (time: number) => Promise<void>; log?: (event: Record<string, unknown>) => void;
}): Promise<void> {
  let nextAt = 0;
  while (!opts.stopped()) {
    const now = opts.clock();
    if (now < nextAt) {
      await opts.sleep(Math.max(1, Math.min(MINUTE_MS, nextAt - now)));
      continue;
    }
    try {
      const result = await opts.collector.collectOnce(now);
      if (result?.changed && !opts.stopped()) {
        // 回调只入共享协调队列；异步通知不能阻断行情采集。
        void opts.requestCalculation(Math.floor(opts.clock() / opts.intervalMs) * opts.intervalMs)
          .catch(() => opts.log?.({ event: 'gmgn_calculation_failed' }));
      }
      nextAt = Math.max(opts.clock() + 1_000, result?.nextAt ?? opts.clock() + MINUTE_MS);
    } catch {
      opts.log?.({ event: 'gmgn_collection_failed' });
      nextAt = opts.clock() + MINUTE_MS;
    }
  }
}

export function createScheduler(opts: { db: StoreDatabase; cfg: StrategyConfig; client: DataClient;
  quota: QuotaGuard; notifier: Notifier; log?: (event: Record<string, unknown>) => void;
  clock?: () => number; operationalAlert?: (message: string) => Promise<void>;
  /** 成功提交行情后只标记共享重算队列；不得由采集器直接评估或通知。 */
  onMarketData?: () => void;
  /** 提供时走 DexScreener 官方批量端点（30 个/批，不消耗二娃配额）；省略则逐个回退 */
  dexBatch?: Pick<DexScreenerClient, 'getAll'>;
  /** K 线主源；省略则回退到二娃的 getKline */
  klineSource?: Pick<GeckoTerminalClient, 'getCandles15m'> & Partial<Pick<GeckoTerminalClient, 'setRateLimitStore'>> }) {
  const { db, cfg, client, quota, notifier } = opts;
  const poolStore = createPoolStore(db);
  const candles = createCandleStore(db);
  const moments = createMomentStore(db);
  const series = createSeriesStore(db);
  const outcomes = createOutcomeStore(db);
  const log = opts.log ?? ((event) => console.log(JSON.stringify(event)));
  let currentNow = 0;
  const clock = () => opts.clock?.() ?? currentNow;
  const state = createRuntimeStore(db, clock);
  client.setRateLimitStore?.(state.rateLimitStore);
  opts.klineSource?.setRateLimitStore?.(state.geckoRateLimitStore);
  let collecting = false;
  let discovering = false;
  let calculating = false;
  let combinedRunning = false;
  let stopping = false;

  const memberNetwork = (member: RoundMember): string => {
    const chain = member.pool.chain ?? member.dex?.chainId;
    return chain ? resolveGeckoNetwork(chain) : '';
  };
  const memberKey = (member: RoundMember) => JSON.stringify([memberNetwork(member), canonicalCa(member.pool.ca)]);
  const validSeries = isSupportedMarketSeries;
  const preferGmgn = (network: string): boolean => {
    const chain = resolveGmgnChain(network);
    return cfg.kline.gmgn.enabled && chain !== null && cfg.kline.gmgn.chains.includes(chain);
  };
  const historyFor = (identity: MarketSeries): SeriesHistory => ({
    candles15m: series.getCandles(identity.id, '15m'), candles60m: series.getCandles(identity.id, '1h'),
    candles4h: series.getCandles(identity.id, '4h'),
  });
  function selectCalculationSeries(member: RoundMember, network: string, now: number, sameSlot: boolean): void {
    // 非空选择在整个 T 内不可改变，即使外部已切 active 或后来补齐了另一来源。
    if (sameSlot && typeof member.seriesId === 'string') return;
    const active = network ? series.getActive(network, member.pool.ca) : null;
    if (active && !validSeries(active)) { member.seriesId = null; return; }
    if (!sameSlot) {
      member.plannedSource = active?.source === 'gmgn' || (!active && preferGmgn(network)) ? 'gmgn' : 'geckoterminal';
    } else if (!member.plannedSource) {
      member.plannedSource = active?.source ?? (preferGmgn(network) ? 'gmgn' : 'geckoterminal');
    }
    if (active?.source === 'gmgn') {
      member.seriesId = !sameSlot || member.plannedSource === 'gmgn' ? active.id : null;
      return;
    }
    // 同 T 的 null 只允许首次绑定预定来源；预定在该 T 的首次选择中确定。
    const allowCandidate = preferGmgn(network) && (!sameSlot || member.plannedSource === 'gmgn');
    const candidate = allowCandidate && network ? series.getTokenSeries(network, member.pool.ca) : null;
    if (isSupportedMarketSeries(candidate) && candidate.source === 'gmgn') {
      const readiness = gmgnReadiness({ candidate: historyFor(candidate), previous: active ? historyFor(active) : null,
        listedAt: member.pool.listedAt, now, cfg });
      if (readiness.ready) {
        const selected = series.switchActiveSeries(candidate.id, active?.id ?? null, clock(), 'gmgn_ready_for_slot');
        member.seriesId = selected.id; member.plannedSource = 'gmgn';
        return;
      }
      // 整点端点通常晚于本地计时器到达。历史已成熟时预定 GMGN，避免每个 T 都先冻结 Gecko。
      // 等待期间当期输入为空；旧 Gecko 值只由独立展示缓存保留。
      if (!sameSlot && active?.source === 'geckoterminal' && readiness.missingCurrent && readiness.historyReady) {
        member.plannedSource = 'gmgn'; member.seriesId = null;
        return;
      }
    }
    member.seriesId = active?.source === 'geckoterminal' && (!sameSlot || member.plannedSource === 'geckoterminal')
      ? active.id : null;
  }
  const clearMemberScores = (member: RoundMember): RoundMember => ({ ...member, result: null,
    rpsScores: emptyScores(), rpsBounds: emptyBounds(), rpsDisplayBounds: emptyBounds() });

  async function updateGeckoMember(member: RoundMember, fixedNow?: number): Promise<void> {
    member.klineStatus = 'error';
    if (!opts.klineSource) throw new GeckoTerminalError('GECKO_INPUT', '尚未配置独立行情源');
    const chain = member.pool.chain ?? member.dex?.chainId;
    const network = chain ? resolveGeckoNetwork(chain) : '';
    const active = network ? series.getActive(network, member.pool.ca) : null;
    if ((validSeries(active) && active.source === 'gmgn') || (!active && preferGmgn(network))) {
      member.seriesId = validSeries(active) ? active.id : null;
      member.klineStatus = active ? 'ready' : 'skipped';
      return;
    }
    const pool = active?.poolAddress ?? member.dex?.pairAddress;
    if (!network || !pool || (!active && member.dex?.chainId
      && resolveGeckoNetwork(member.dex.chainId) !== network)) {
      throw new GeckoTerminalError('GECKO_INPUT', '缺少可验证的网络或交易对');
    }
    if (active && (active.source !== 'geckoterminal' || active.currency !== 'usd' || active.formatVersion !== MARKET_SERIES_FORMAT_VERSION)) {
      member.seriesId = null;
      throw new GeckoTerminalError('GECKO_INPUT', '固定行情序列口径不兼容，需要显式迁移');
    }
    member.seriesId = active?.id ?? null;
    const requestedAt = fixedNow ?? clock();
    const fetched = await opts.klineSource.getCandles15m(network, pool, cfg.kline.bars15m, member.pool.ca);
    // 每个请求独立取时钟，避免长轮丢掉后来已闭合的数据；跨界响应仍只接纳请求前已闭合的 bar。
    const receivedAt = fixedNow ?? clock();
    const bars = closedCandles(fetched, INTERVAL_MS['15m'], Math.min(requestedAt, receivedAt));
    if (!bars.length) {
      throw new GeckoTerminalError('GECKO_VALIDATION', '行情响应为空，保留未知状态');
    }
    const saved = db.transaction(() => {
      const identity = active ?? series.ensureSeries({ source: 'geckoterminal', network,
        ca: member.pool.ca, poolAddress: pool, currency: 'usd', formatVersion: MARKET_SERIES_FORMAT_VERSION }, receivedAt);
      series.upsertCandles(identity.id, '15m', bars);
      // 从本序列累计的15m合成；跨轮的桶也可完整形成，绝不拼接其他池。
      const accumulated = series.getCandles(identity.id, '15m').reverse();
      series.upsertCandles(identity.id, '1h', aggregateCandles(accumulated, INTERVAL_MS['15m'], INTERVAL_MS['1h']));
      series.upsertCandles(identity.id, '4h', aggregateCandles(accumulated, INTERVAL_MS['15m'], INTERVAL_MS['4h']));
      // HTTP 期间新 T 可以切换到 GMGN；保留此次 Gecko 历史但绝不重新夺回 active。
      const selected = series.getActive(network, member.pool.ca);
      return selected ?? series.activateSeries(identity.id, receivedAt);
    })();
    member.seriesId = saved.id;
    member.klineStatus = 'ready';
    opts.onMarketData?.();
  }

  async function collect(now: number, compatibility: boolean): Promise<RoundReport | null> {
    if (collecting || stopping) { log({ event: 'collection_skipped', reason: stopping ? 'stopping' : 'already_running' }); return null; }
    currentNow = now;
    collecting = true;
    const snapshot = initialRound(cfg, now);
    const previous = state.getCollectionRound() ?? state.getRound();
    if (previous?.strategyKey === snapshot.strategyKey) {
      // 观察池尚在读取时保留资产列表；旧评分仅由独立展示缓存提供。
      snapshot.members = previous.members.map((member) => ({
        ...member, qualified: false, result: null, dexStatus: 'pending', klineStatus: 'skipped',
        rpsScores: emptyScores(), rpsBounds: emptyBounds(), rpsDisplayBounds: emptyBounds(),
      }));
    }
    const saveProgress = () => {
      state.saveCollectionRound(snapshot);
      // 仅旧 runOnce/干跑保留原来的进度接口；生产采集绝不覆盖评分。
      if (compatibility) state.saveRound(snapshot.status === 'complete' || snapshot.status === 'partial'
        ? { ...snapshot, status: 'running', completedAt: null } : snapshot);
    };
    const report: RoundReport = { now, poolSize: 0, candidateCount: 0, poolComplete: false, failures: 0,
      degraded: false, halted: false, results: [] };
    const failure = (stage: string, error: unknown, ca?: string) => {
      snapshot.failures++;
      log({ event: 'request_failed', stage, ...(ca ? { ca } : {}), code: error instanceof ErwaError || error instanceof QuotaStopError
        || error instanceof TelegramError || error instanceof PoolSelectionError || error instanceof RuntimeStateError
        || error instanceof StrategyConfigError || error instanceof GeckoTerminalError || error instanceof MarketSeriesError ? error.code : 'UNEXPECTED_ERROR' });
    };
    const halted = () => stopping || quota.state(clock()).halted || state.rateLimitStore.getUntil() > clock();
    async function syncUsage(stage: string) {
      const remote = await client.getTokenUsage();
      quota.sync(remote.usedToday, remote.dailyLimit, clock());
      snapshot.quota = { used: quota.state(clock()).used, limit: quota.state(clock()).limit };
      log({ event: 'usage_checked', stage, usedToday: remote.usedToday, remainingToday: remote.remainingToday });
      return remote;
    }
    try {
      saveProgress();
      if (halted()) { snapshot.status = 'halted'; return report; }
      // 远端配额查询失败不应作废整轮：本地 api_usage 一直在记账，
      // 足以支撑降级/停止判定。此前一次网络抖动就中止，实测 10 轮里 6 轮空转。
      try { await syncUsage('round_start'); }
      catch (error) {
        failure('usage', error);
        if (quota.state(clock()).halted) { snapshot.status = 'halted'; return report; }
        log({ event: 'usage_sync_degraded', stage: 'round_start', reason: 'fallback_to_local_counter' });
      }
      if (halted()) { snapshot.status = 'halted'; return report; }

      const groups: { groupName: string; items: BoardPoolItem[] }[] = [];
      for (const groupName of [...new Set(cfg.observeGroups)]) {
        if (halted()) { snapshot.status = 'halted'; return report; }
        try { groups.push({ groupName, items: await client.getBoardSummary({ groupName, days: cfg.pool.historyDays, limit: cfg.pool.perGroupLimit }) }); }
        catch (error) { failure('board', error); snapshot.status = 'failed'; return report; }
      }
      let selected;
      try { selected = selectObservationPool(groups, cfg); }
      catch (error) { failure('pool_selection', error); snapshot.status = 'failed'; return report; }
      snapshot.boardComplete = true;
      snapshot.sourceCount = selected.sourceCount;
      snapshot.sourceLimited = selected.sourceLimited;
      const archives = poolStore.getPool();
      poolStore.upsertPool(selected.items, now);
      snapshot.members = selected.items.map((item) => {
        const pool = poolStore.getPoolItem(item.ca)!;
        const aliases = archives.filter((row) => canonicalCa(row.ca) === item.ca);
        pool.firstSeenAt = Math.min(pool.firstSeenAt, ...aliases.map((row) => row.firstSeenAt));
        // 旧库的 K 线/first_seen 估算不冒充 DexScreener 已确认的上市时间。
        const listingNetwork = pool.chain ? resolveGeckoNetwork(pool.chain) : null;
        pool.listedAt = opts.klineSource
          ? listingNetwork ? state.getListing(item.ca, listingNetwork) : null
          : state.getListing(item.ca);
        const member = pendingMember(pool, item.totalMentions);
        if (opts.klineSource) {
          const network = pool.chain ? resolveGeckoNetwork(pool.chain) : null;
          const active = network ? series.getActive(network, pool.ca) : null;
          member.seriesId = validSeries(active) ? active.id : null;
        }
        return member;
      });
      saveProgress();
      log({ event: 'pool_selected', sourceCount: selected.sourceCount, poolSize: snapshot.members.length,
        maxCandidates: cfg.pool.maxCandidates, sourceLimited: selected.sourceLimited, rankBy: cfg.pool.rankBy });

      if (snapshot.members.length) {
        try { await syncUsage('before_dex'); }
        catch (error) {
          // 与 round_start 一致：远端配额查询失败即降级，靠本地 api_usage 记账继续，
          // 只有本地计数确实到停止阈值才中止。三处若不一致，等于修了一处漏两处。
          failure('usage_before_dex', error);
          if (quota.state(clock()).halted) { snapshot.status = 'halted'; return report; }
          log({ event: 'usage_sync_degraded', stage: 'before_dex', reason: 'fallback_to_local_counter' });
        }
        // 批量优先：官方端点 30 个/批，495 个 CA 仅需约 23 次请求（逐个则 495 次）
        let batchFailed = false;
        const batched = opts.dexBatch
          ? await opts.dexBatch.getAll(snapshot.members.map((member) => ({ ca: member.pool.ca, chain: member.pool.chain })))
              .catch((error: unknown) => { failure('dex_batch', error); batchFailed = true; return new Map<string, DexSnapshot>(); })
          : null;
        const applyDex = (member: RoundMember, snap: DexSnapshot | undefined) => {
          const reportedNetwork = snap?.chainId ? resolveGeckoNetwork(snap.chainId) : null;
          const expectedNetwork = member.pool.chain ? resolveGeckoNetwork(member.pool.chain) : reportedNetwork;
          if (opts.klineSource && snap && (!reportedNetwork || reportedNetwork !== expectedNetwork)) {
            member.dexStatus = 'error';
            failure('dex_identity', new GeckoTerminalError('GECKO_VALIDATION', '行情链与观察成员不一致'), member.pool.ca);
            snap = undefined;
          }
          if (snap) {
            member.dex = snap;
            member.dexAt = clock();
            member.dexStatus = 'ok';
            const created = snap.pairCreatedAt;
            if (member.pool.listedAt === null && created !== null && created <= now) {
              member.pool.listedAt = opts.klineSource && reportedNetwork
                ? state.cacheListing(member.pool.ca, created, reportedNetwork)
                : state.cacheListing(member.pool.ca, created);
            }
          }
          // A2 复用 summary 已提供的精确市值/流动性；不为 A2 额外请求行情。
          const gates = checkPreconditions({ pool: member.pool, listedAt: member.pool.listedAt, now }, cfg);
          member.qualified = gates.a1 && gates.a2;
          poolStore.setListedAt(member.pool.ca, member.pool.listedAt);
        };
        if (batched) {
          for (const member of snapshot.members) {
            const snap = batched.get(canonicalCa(member.pool.ca));
            // 批量调用已成功返回：缺这个 CA 表示上游确认它没有交易对，而非本次请求失败。
            if (!snap) member.dexStatus = batchFailed ? 'error' : 'absent';
            applyDex(member, snap);
          }
        } else {
          let next = 0;
          async function dexWorker() {
            while (next < snapshot.members.length && !halted()) {
              const member = snapshot.members[next++]!;
              let snap: DexSnapshot | undefined;
              let answered = true;
              try { snap = await client.getDexScreener(member.pool.ca); }
              catch (error) { answered = false; member.dexStatus = 'error'; failure('dex', error, member.pool.ca); }
              // 请求成功但没有返回交易对：上游确认该 CA 无市场，与请求失败区分。
              if (!snap && answered) member.dexStatus = 'absent';
              applyDex(member, snap);
            }
          }
          await Promise.all([dexWorker(), dexWorker()]);
        }
        saveProgress();
        try { await syncUsage('after_dex'); }
        catch (error) {
          // 与 round_start 一致：远端配额查询失败即降级，靠本地 api_usage 记账继续，
          // 只有本地计数确实到停止阈值才中止。三处若不一致，等于修了一处漏两处。
          failure('usage_after_dex', error);
          if (quota.state(clock()).halted) { snapshot.status = 'halted'; return report; }
          log({ event: 'usage_sync_degraded', stage: 'after_dex', reason: 'fallback_to_local_counter' });
        }
      }
      if (halted()) { snapshot.status = 'halted'; return report; }
      const round = Math.floor(now / (cfg.schedule.mainLoopMinutes * MINUTE_MS));
      for (const member of snapshot.members) {
        // 注意：不能只给 qualified 的拉 K 线。RPS 是相对排名，需求要求
        // 「池子为观察组」，若只算通过 A1/A2 的子集，排名基准就变了。
        // 当 K 线源要消耗二娃配额时这是个无奈取舍；改用 GeckoTerminal（免费）后
        // 该约束已无必要 —— 少拉的那些适龄成员会直接拉低 RPS 覆盖率。
        const klineFree = Boolean(opts.klineSource);
        if (!member.qualified && !klineFree) continue;
        if (halted()) { snapshot.status = 'halted'; return report; }
        const refresh = cfg.schedule.klineRefresh;
        // 群聊里混入的残缺 EVM 地址查行情必然失败，却照样消耗配额 —— 本地直接跳过
        if (!isQueryableCa(member.pool.ca)) {
          member.klineStatus = 'error';
          log({ event: 'kline_skipped', ca: member.pool.ca, reason: 'malformed_evm_address' });
          saveProgress();
          continue;
        }
        // 新接入只读取可追溯序列。首次成功后固定池；失败不混入未知来源的旧行情。
        if (opts.klineSource) {
          member.klineStatus = 'error';
          try { await updateGeckoMember(member, compatibility ? now : undefined);
          } catch (error) { failure('kline_gecko', error, member.pool.ca); }
          // 只发布采集进度；RPS 和告警仍在全池处理完后统一计算。
          saveProgress();
          continue;
        }

        const ranges: Range[] = [];
        if (round % refresh.range24h === 0 || !candles.getCandles(member.pool.ca, '15m', 1).length) ranges.push('24h');
        if (!quota.state(clock()).degraded) {
          if (round % refresh.range7d === 0 || !candles.getCandles(member.pool.ca, '1h', 1).length) ranges.push('7d');
          if (round % refresh.range30d === 0 || !candles.getCandles(member.pool.ca, '4h', 1).length) ranges.push('30d');
        }
        member.klineStatus = 'ready';
        for (const range of ranges) {
          if (halted()) { snapshot.status = 'halted'; return report; }
          if (range !== '24h' && quota.state(clock()).degraded) continue;
          try { const data = await client.getKline(member.pool.ca, range); candles.upsertCandles(member.pool.ca, data.interval, data.candles); }
          catch (error) {
            failure(`kline_${range}`, error, member.pool.ca);
            if (range === '24h') { member.klineStatus = 'error'; break; }
          }
        }
      }
      snapshot.status = snapshot.failures ? 'partial' : 'complete';
      return report;
    } catch (error) {
      failure('round', error); snapshot.status = 'failed'; return report;
    } finally {
      snapshot.completedAt = clock();
      snapshot.quota = { used: quota.state(clock()).used, limit: quota.state(clock()).limit };
      report.poolSize = snapshot.members.length;
      report.candidateCount = snapshot.members.filter((member) => member.qualified).length;
      report.poolComplete = snapshot.boardComplete;
      report.failures = snapshot.failures;
      report.degraded = quota.state(clock()).degraded;
      report.halted = snapshot.status === 'halted';
      if (snapshot.status === 'halted' || snapshot.status === 'failed') {
        for (const member of snapshot.members) { member.rpsScores = emptyScores(); member.rpsBounds = emptyBounds(); member.rpsDisplayBounds = emptyBounds(); member.result = null; }
        for (const coverage of Object.values(snapshot.coverage)) { coverage.complete = false; coverage.boundedPassCount = 0; }
      }
      try { saveProgress(); } finally { collecting = false; }
      log({ event: 'collection_complete', now, poolSize: report.poolSize, candidateCount: report.candidateCount,
        sourceCount: snapshot.sourceCount, sourceLimited: snapshot.sourceLimited, poolComplete: report.poolComplete,
        evaluated: report.results.length, failures: report.failures, degraded: report.degraded, halted: report.halted, rpsCoverage: snapshot.coverage });
      if (report.halted && !stopping) {
        try { await opts.operationalAlert?.('Alpha-Reset：配额保护、查询失败或账号限流，本轮停止拉取。'); }
        catch (error) { log({ event: 'operational_alert_failed', code: error instanceof TelegramError ? error.code : 'UNEXPECTED_ERROR' }); }
      }
    }
  }
  /** 持续采集：只更新行情及完整池快照，不计算 RPS，不通知。 */
  async function collectOnce(now = opts.clock?.() ?? Date.now()): Promise<RoundReport | null> {
    if (combinedRunning) return null;
    return collect(now, false);
  }

  /** 独立发现三群完整近期列表；行情冷却不能阻断此流程。 */
  async function discoverOnce(now = opts.clock?.() ?? Date.now()): Promise<RoundReport | null> {
    if (discovering || combinedRunning || stopping) return null;
    discovering = true;
    currentNow = Math.max(currentNow, now);
    const snapshot = initialRound(cfg, now);
    const previous = state.getObservationRound();
    if (previous) snapshot.members = previous.members.map(clearMemberScores);
    const report: RoundReport = { now, poolSize: 0, candidateCount: 0, poolComplete: false,
      failures: 0, degraded: false, halted: false, results: [] };
    const failure = (stage: string, error: unknown, ca?: string) => {
      snapshot.failures++;
      log({ event: 'request_failed', stage, ...(ca ? { ca } : {}),
        code: error instanceof ErwaError || error instanceof GeckoTerminalError || error instanceof PoolSelectionError
          || error instanceof QuotaStopError || error instanceof RuntimeStateError ? error.code : 'UNEXPECTED_ERROR' });
    };
    const erwaBlocked = () => stopping || quota.state(clock()).halted || state.rateLimitStore.getUntil() > clock();
    const save = () => {
      state.saveDiscoveryRound(snapshot);
      if (snapshot.boardComplete) state.saveObservationRound(snapshot);
    };
    try {
      save();
      if (erwaBlocked()) { snapshot.status = 'halted'; return report; }
      try {
        const usage = await client.getTokenUsage();
        quota.sync(usage.usedToday, usage.dailyLimit, clock());
      } catch (error) { failure('discovery_usage', error); }
      if (erwaBlocked()) { snapshot.status = 'halted'; return report; }
      const groups: { groupName: string; items: BoardPoolItem[] }[] = [];
      for (const groupName of [...new Set(cfg.observeGroups)]) {
        if (erwaBlocked()) { snapshot.status = 'halted'; return report; }
        try { groups.push({ groupName, items: await client.getBoardSummary({ groupName, days: cfg.pool.historyDays, limit: cfg.pool.perGroupLimit }) }); }
        catch (error) { failure('discovery_board', error); snapshot.status = 'failed'; return report; }
      }
      const selected = selectObservationPool(groups, cfg);
      poolStore.upsertPool(selected.items, now);
      snapshot.members = selected.items.map((item) => {
        const pool = poolStore.getPoolItem(item.ca)!;
        const prior = previous?.members.find((member) => canonicalCa(member.pool.ca) === canonicalCa(item.ca)
          && resolveGeckoNetwork(member.pool.chain ?? '') === resolveGeckoNetwork(pool.chain ?? ''));
        const member = pendingMember(pool, item.totalMentions);
        // 重用此前已验证的 Dex 身份；不能把异链响应或旧规则值带入新发现。
        if (prior?.dex) {
          const actual = resolveGeckoNetwork(prior.dex.chainId ?? '');
          const expected = resolveGeckoNetwork(pool.chain ?? prior.dex.chainId ?? '');
          if (actual && actual === expected) { member.dex = prior.dex; member.dexAt = prior.dexAt; member.dexStatus = prior.dexStatus; }
        }
        const network = memberNetwork(member);
        const active = network ? series.getActive(network, pool.ca) : null;
        member.pool.listedAt = network ? state.getListing(pool.ca, network) : null;
        member.seriesId = validSeries(active) ? active!.id : null;
        const gates = checkPreconditions({ pool, listedAt: member.pool.listedAt, now }, cfg);
        member.qualified = gates.a1 && gates.a2;
        return member;
      });
      const before = new Set(previous?.members.map(memberKey) ?? []);
      const after = new Set(snapshot.members.map(memberKey));
      snapshot.addedCount = [...after].filter((key) => !before.has(key)).length;
      snapshot.removedCount = [...before].filter((key) => !after.has(key)).length;
      snapshot.boardComplete = true;
      snapshot.sourceCount = selected.sourceCount;
      snapshot.sourceLimited = selected.sourceLimited;
      snapshot.observedAt = clock();
      db.transaction(() => {
        for (const member of snapshot.members) state.ensureCollectionQueue(memberNetwork(member), member.pool.ca);
        save();
      })();
      log({ event: 'pool_discovered', observedAt: snapshot.observedAt, sourceCount: snapshot.sourceCount,
        poolSize: snapshot.members.length, addedCount: snapshot.addedCount, removedCount: snapshot.removedCount,
        sourceLimited: snapshot.sourceLimited, maxCandidates: cfg.pool.maxCandidates });
      const needsDex = snapshot.members.filter((member) => {
        if (!isQueryableCa(member.pool.ca)) return false;
        const network = memberNetwork(member);
        const active = network ? series.getActive(network, member.pool.ca) : null;
        // 已固定的来源即使暂不兼容也不得靠查询另一池自动切换。
        if (active && !validSeries(active)) return false;
        return (!active && !member.dex?.pairAddress) || member.pool.listedAt === null;
      });
      // answered=true 表示上游成功应答；此时没有交易对是已验证的「无市场」，不是请求失败。
      const applyDex = (member: RoundMember, dex: DexSnapshot | undefined, answered = false) => {
        const reported = dex?.chainId ? resolveGeckoNetwork(dex.chainId) : '';
        const expected = memberNetwork(member) || reported;
        if (!dex || !reported || reported !== expected) {
          member.dexStatus = !dex && answered ? 'absent' : 'error';
          if (dex) failure('discovery_dex_identity', new GeckoTerminalError('GECKO_VALIDATION', '行情链与观察成员不一致'), member.pool.ca);
          return;
        }
        member.dex = dex; member.dexAt = clock(); member.dexStatus = 'ok';
        if (member.pool.listedAt === null && dex.pairCreatedAt !== null && dex.pairCreatedAt <= clock()) {
          member.pool.listedAt = state.cacheListing(member.pool.ca, dex.pairCreatedAt, reported);
        }
        const active = series.getActive(reported, member.pool.ca);
        member.seriesId = validSeries(active) ? active!.id : null;
        const gates = checkPreconditions({ pool: member.pool, listedAt: member.pool.listedAt, now: clock() }, cfg);
        member.qualified = gates.a1 && gates.a2;
        poolStore.setListedAt(member.pool.ca, member.pool.listedAt);
        state.ensureCollectionQueue(reported, member.pool.ca);
      };
      if (needsDex.length && !stopping) {
        if (opts.dexBatch) {
          try {
            const dex = await opts.dexBatch.getAll(needsDex.map((member) => ({ ca: member.pool.ca, chain: member.pool.chain })));
            for (const member of needsDex) applyDex(member, dex.get(canonicalCa(member.pool.ca)), true);
          } catch (error) { failure('discovery_dex_batch', error); for (const member of needsDex) member.dexStatus = 'error'; }
        } else {
          // 仅兼容未注入官方批量源的调用，二娃冷却时不访问其代理。
          let next = 0;
          async function worker() {
            while (next < needsDex.length && !erwaBlocked()) {
              const member = needsDex[next++]!;
              try { applyDex(member, await client.getDexScreener(member.pool.ca), true); }
              catch (error) { member.dexStatus = 'error'; failure('discovery_dex', error, member.pool.ca); }
            }
          }
          await Promise.all([worker(), worker()]);
        }
      }
      snapshot.status = snapshot.failures ? 'partial' : 'complete';
      return report;
    } catch (error) { failure('discovery', error); snapshot.status = 'failed'; return report; }
    finally {
      snapshot.completedAt = clock();
      snapshot.quota = { used: quota.state(clock()).used, limit: quota.state(clock()).limit };
      try { save(); } finally { discovering = false; }
      report.poolSize = snapshot.members.length; report.poolComplete = snapshot.boardComplete;
      report.candidateCount = snapshot.members.filter((member) => member.qualified).length;
      report.failures = snapshot.failures; report.halted = snapshot.status === 'halted'; report.degraded = quota.state(clock()).degraded;
      log({ event: 'discovery_complete', now, observedAt: snapshot.observedAt ?? null, status: snapshot.status,
        poolSize: report.poolSize, failures: report.failures });
    }
  }

  /** 串行、公平消费最新完整池；每次尝试前持久移到队尾，失败/重启不重置顺序。 */
  async function collectKnownPoolOnce(now = opts.clock?.() ?? Date.now()): Promise<RoundReport | null> {
    if (collecting || combinedRunning || stopping) return null;
    collecting = true; currentNow = Math.max(currentNow, now);
    const snapshot = initialRound(cfg, now);
    const report: RoundReport = { now, poolSize: 0, candidateCount: 0, poolComplete: false,
      failures: 0, degraded: false, halted: false, results: [] };
    const attempted = new Set<string>();
    const progress = new Map<string, Pick<RoundMember, 'seriesId' | 'klineStatus'>>();
    const save = () => state.saveCollectionRound(snapshot, false);
    try {
      for (;;) {
        if (stopping) { snapshot.status = 'halted'; break; }
        const observation = state.getObservationRound();
        if (!observation?.boardComplete || observation.strategyKey !== strategyKey(cfg)) return null;
        snapshot.boardComplete = true; snapshot.sourceCount = observation.sourceCount; snapshot.sourceLimited = observation.sourceLimited;
        snapshot.members = observation.members.map((original) => {
          const member: RoundMember = { ...clearMemberScores(original), klineStatus: 'skipped', ...progress.get(memberKey(original)) };
          const network = memberNetwork(member);
          const active = network ? series.getActive(network, member.pool.ca) : null;
          if (member.seriesId !== undefined || opts.klineSource) member.seriesId = validSeries(active) ? active.id : null;
          member.plannedSource = validSeries(active) ? active.source : preferGmgn(network) ? 'gmgn' : 'geckoterminal';
          return member;
        });
        // 新成员在已有等待者之后登记；每次循环重新取池，移出的 CA 不继续请求。
        const queue = db.transaction(() => snapshot.members.map((member) => ({ member,
          order: state.ensureCollectionQueue(memberNetwork(member), member.pool.ca).sequence })))()
          .filter(({ member }) => !attempted.has(memberKey(member)))
          .filter(({ member }) => {
            const network = memberNetwork(member);
            const active = network ? series.getActive(network, member.pool.ca) : null;
            return active ? !(validSeries(active) && active.source === 'gmgn') : !preferGmgn(network);
          })
          // 群列表先发布，待新成员的 Dex 身份确认后再发起行情请求。
          .filter(({ member }) => member.dexStatus !== 'pending' || Boolean(member.seriesId)
            || !isQueryableCa(member.pool.ca))
          .sort((a, b) => a.order - b.order);
        save();
        if (!queue.length) { snapshot.status = snapshot.failures ? 'partial' : 'complete'; break; }
        if (state.geckoRateLimitStore.getUntil() > clock()) { snapshot.status = 'halted'; break; }
        const member = queue[0]!.member;
        const key = memberKey(member);
        attempted.add(key);
        // 在 HTTP 之前提交，即使请求中进程退出也会从下一个成员续采。
        state.recordCollectionAttempt(memberNetwork(member), member.pool.ca, clock());
        try {
          if (!isQueryableCa(member.pool.ca)) throw new GeckoTerminalError('GECKO_INPUT', '地址格式无效');
          await updateGeckoMember(member);
        } catch (error) {
          member.klineStatus = 'error'; snapshot.failures++;
          log({ event: 'request_failed', stage: 'kline_gecko', ca: member.pool.ca,
            code: error instanceof GeckoTerminalError || error instanceof MarketSeriesError ? error.code : 'UNEXPECTED_ERROR' });
          if (error instanceof GeckoTerminalError && (error.code === 'GECKO_RATE_LIMIT' || error.httpStatus === 429)) {
            const retryAt = error.retryAt ?? clock() + Math.ceil(MINUTE_MS / Math.min(cfg.kline.requestsPerMinute, 10));
            state.geckoRateLimitStore.setUntil(retryAt);
            log({ event: 'gecko_cooldown', retryAt, ca: member.pool.ca });
            snapshot.status = 'halted';
          }
        }
        progress.set(key, { seriesId: member.seriesId, klineStatus: member.klineStatus });
        save();
        if (snapshot.status === 'halted') break;
      }
      return report;
    } finally {
      snapshot.completedAt = clock();
      snapshot.quota = { used: quota.state(clock()).used, limit: quota.state(clock()).limit };
      try { save(); } finally { collecting = false; }
      report.poolSize = snapshot.members.length; report.poolComplete = snapshot.boardComplete;
      report.candidateCount = snapshot.members.filter((member) => member.qualified).length;
      report.failures = snapshot.failures; report.halted = snapshot.status === 'halted'; report.degraded = quota.state(clock()).degraded;
      log({ event: 'collection_complete', now, poolSize: report.poolSize, attempted: attempted.size, failures: report.failures, halted: report.halted });
    }
  }

  async function calculate(now: number, compatibility: boolean): Promise<RoundReport | null> {
    if (calculating || stopping) { log({ event: 'calculation_skipped', reason: stopping ? 'stopping' : 'already_running' }); return null; }
    if (!Number.isSafeInteger(now) || now < 0 || now > (opts.clock?.() ?? Math.max(currentNow, now))) {
      throw new RuntimeStateError();
    }
    currentNow = Math.max(currentNow, now);
    calculating = true;
    let published: RoundSnapshot | null = null;
    const notifications: Notification[] = [];
    const report: RoundReport = { now, poolSize: 0, candidateCount: 0, poolComplete: false, failures: 0,
      degraded: quota.state(clock()).degraded, halted: false, results: [] };
    try {
      // 同步事务读取全池和全部行情，再原子提交时刻/当前计算/展示缓存；不把网络等待放进事务。
      const computed = db.transaction(() => {
        const observation = state.getObservationRound();
        const previous = state.getRound();
        const key = strategyKey(cfg);
        if (!observation?.boardComplete) return null;
        // 只允许同一完整配置从旧计算口径 v1 升级；池筛选配置改变必须重新发现观察池。
        const previousContractKey = createHash('sha256').update('market-contract-v1:').update(JSON.stringify(cfg)).digest('hex');
        if (observation.strategyKey !== key && !(opts.klineSource && observation.strategyKey === previousContractKey)) return null;
        if (!compatibility && previous?.strategyKey === key && previous.startedAt > now) return null;
        // 同一 T 的修订保持首次确立的全池分母。下一 T 才接纳新观察池成员。
        const sameSlot = !compatibility && previous?.strategyKey === key && previous.startedAt === now
          && previous.boardComplete && previous.rpsInputKey;
        const snapshot = structuredClone(sameSlot ? previous : observation);
        snapshot.strategyKey = key;
        snapshot.startedAt = now;
        snapshot.completedAt = null;
        snapshot.status = 'running';
        snapshot.failures = compatibility ? observation.failures : 0;
        snapshot.rpsFromPreviousRound = false;
        snapshot.rpsRevision = sameSlot ? (previous.rpsRevision ?? 1) + 1 : 1;
        for (const member of snapshot.members) {
          member.rpsScores = emptyScores(); member.rpsBounds = emptyBounds(); member.rpsDisplayBounds = emptyBounds(); member.result = null;
          if (!compatibility) {
            const latest = observation.members.find((item) => canonicalCa(item.pool.ca) === canonicalCa(member.pool.ca)
              && item.pool.chain === member.pool.chain);
            if (latest) {
              const frozenChain = member.pool.chain ?? member.dex?.chainId;
              const latestChain = latest.pool.chain ?? latest.dex?.chainId;
              // 同 T 首次确认的链不随后续 pending/error 或异链 Dex 响应改变。
              if (latest.dex && latest.dexStatus === 'ok' && (!frozenChain || (latestChain
                && resolveGeckoNetwork(frozenChain) === resolveGeckoNetwork(latestChain)))) {
                member.dex = latest.dex; member.dexAt = latest.dexAt;
              }
              member.dexStatus = latest.dexStatus; member.klineStatus = latest.klineStatus;
            }
            const chain = member.pool.chain ?? member.dex?.chainId;
            const network = chain ? resolveGeckoNetwork(chain) : '';
            if (member.seriesId !== undefined || opts.klineSource) {
              member.pool.listedAt = network ? state.getListing(member.pool.ca, network) : null;
              selectCalculationSeries(member, network, now, Boolean(sameSlot));
            }
            const gates = checkPreconditions({ pool: member.pool, listedAt: member.pool.listedAt, now }, cfg);
            member.qualified = gates.a1 && gates.a2;
          }
        }
        const inputs = readRoundInputs(db, cfg, now, snapshot.members);
        const baseline = Math.floor(now / INTERVAL_MS['15m']) * INTERVAL_MS['15m'];
        const inputKey = createHash('sha256').update(JSON.stringify(inputs.map((input, i) => {
          const prices = new Map<number, number>();
          for (const [bars, interval] of [[input.candles60m, INTERVAL_MS['1h']], [input.candles15m, INTERVAL_MS['15m']]] as const) {
            for (const bar of closedCandles(bars, interval, baseline)) {
              if (Number.isFinite(bar.close) && bar.close > 0) prices.set(bar.openTime + interval, bar.close);
            }
          }
          return { ca: input.ca, chain: input.pool.chain, seriesId: snapshot.members[i]!.seriesId,
            listedAt: input.listedAt, marketCap: input.pool.marketCap, liquidity: input.pool.liquidity,
            firstClose: Math.min(Infinity, ...prices.keys()), current: prices.get(baseline) ?? null,
            starts: RPS_KEYS.map((key) => prices.get(baseline - cfg.a4_rps.periods[key].bars * INTERVAL_MS['15m']) ?? null) };
        }))).digest('hex');
        if (sameSlot && previous.rpsInputKey === inputKey) return null;
        snapshot.rpsInputKey = inputKey;
        const ranking = calculateObservationRps(inputs.map((input, i) => ({ ca: input.ca, listedAt: input.listedAt,
          candles15m: input.candles15m, candles60m: input.candles60m, dex: snapshot.members[i]!.dex, dexStatus: snapshot.members[i]!.dexStatus })), now, cfg);
        snapshot.coverage = ranking.coverage;
        for (let i = 0; i < inputs.length; i++) {
          const input = inputs[i]!;
          const member = snapshot.members[i]!;
          member.rpsScores = ranking.scores.get(input.ca) ?? emptyScores();
          input.rpsScores = member.rpsScores;
          member.rpsBounds = ranking.bounds.get(input.ca) ?? emptyBounds();
          member.rpsDisplayBounds = ranking.displayBounds.get(input.ca) ?? emptyBounds();
          input.rpsBounds = member.rpsBounds;
          // 生产计算只取数据库快照；当前一次 HTTP 失败不能抹掉 T 已有的有效端点。
          if (!member.qualified || (compatibility && member.klineStatus !== 'ready')) {
            input.candles30m = []; input.candles60m = []; input.candles4h = [];
          }
          const result = evaluate(input);
          member.result = result;
          if (member.seriesId) series.upsertMoments(member.seriesId, result.newMoments, now);
          else if (member.seriesId === undefined) moments.upsertMoments(input.ca, result.newMoments, now);
          report.results.push({ ca: input.ca, result });
          log({ event: 'evaluate', ca: input.ca, symbol: input.pool.symbol, listedAt: input.listedAt, qualified: member.qualified,
            reasons: result.reasons, rpsScores: input.rpsScores, rpsBounds: input.rpsBounds, seriesId: member.seriesId ?? null,
            tags: result.tags, newMoments: result.newMoments.length });
          const frames = { '30m': input.candles30m, '60m': input.candles60m, '4h': input.candles4h };
          const indicators = Object.fromEntries(PERIODS.map((period) => {
            const bars = contiguousTail(closedCandles(frames[period], PERIOD_MS[period], now), PERIOD_MS[period]);
            return [period, { candle: bars.at(-1) ?? null, rsi: rsi(bars, cfg.indicators.rsiPeriod).at(-1) ?? null,
              volumeMa: sma(bars.map((bar) => bar.volume), cfg.supplementary.volMaPeriod).at(-1) ?? null }];
          }));
          notifications.push({ ca: input.ca, pool: input.pool, now, tags: result.tags, rpsScores: input.rpsScores, rpsBounds: member.rpsBounds,
            // 触发时的市值必须随告警冻结：ca_pool 里的是当前值，事后回看会张冠李戴。
            payload: { reasons: result.reasons, marketCap: input.pool.marketCap,
              listedAt: input.listedAt, listingSource: 'dex', strategyVersion: cfg.version,
              newMoments: result.newMoments, indicators, dex: member.dex, rpsCoverage: ranking.coverage,
              marketSeries: member.seriesId ? series.getSeries(member.seriesId) : null,
              rpsBaseline: now, rpsRevision: snapshot.rpsRevision } });
        }
        // 事后表现登记：告警组与对照组同表。只登记通过 A1∧A2 且在基准 T 有同源收盘价的成员，
        // 因为只有这批才可能告警，用它们做对照才公平。纯本地写入，不产生上游请求。
        if (!compatibility) {
          const entries = [];
          for (let i = 0; i < inputs.length; i++) {
            const member = snapshot.members[i]!;
            if (!member.qualified || !member.seriesId) continue;
            const bar = inputs[i]!.candles15m.find((candle) => candle.openTime === baseline - INTERVAL_MS['15m']);
            if (!bar || !Number.isFinite(bar.close) || bar.close <= 0) continue;
            for (const hours of cfg.outcomes.horizonsHours) {
              entries.push({ ca: inputs[i]!.ca, baselineAt: baseline, horizonHours: hours,
                alerted: (member.result?.tags.length ?? 0) > 0, tags: member.result?.tags ?? [],
                seriesId: member.seriesId, entryPrice: bar.close });
            }
          }
          if (entries.length) outcomes.recordCohort(entries, clock());
        }
        snapshot.status = snapshot.failures || (!compatibility && Object.values(snapshot.coverage).some((coverage) => !coverage.complete))
          ? 'partial' : 'complete';
        snapshot.completedAt = clock();
        snapshot.quota = { used: quota.state(clock()).used, limit: quota.state(clock()).limit };
        state.saveRound(snapshot);
        return snapshot;
      })();
      if (!computed) { log({ event: 'calculation_skipped', now, reason: 'no_new_complete_input' }); return null; }
      published = computed;
      // 发布后才异步通知。采集可继续写库；通知始终使用上面冻结的 T 和规则输入。
      for (const notification of notifications) {
        if (stopping) break;
        try { await notifier.notify(notification); }
        catch (error) {
          computed.failures++;
          log({ event: 'request_failed', stage: 'notify', ca: notification.ca,
            code: error instanceof TelegramError ? error.code : 'UNEXPECTED_ERROR' });
        }
      }
      if (computed.failures !== (compatibility ? state.getObservationRound()?.failures ?? 0 : 0)) {
        computed.status = 'partial';
        state.saveRound(computed);
      }
      report.poolSize = computed.members.length;
      report.candidateCount = computed.members.filter((member) => member.qualified).length;
      report.poolComplete = computed.boardComplete;
      report.failures = computed.failures;
      log({ event: 'round_complete', now, rpsRevision: computed.rpsRevision, poolSize: report.poolSize,
        evaluated: report.results.length, failures: report.failures, rpsCoverage: computed.coverage });
      return report;
    } catch (error) {
      log({ event: 'calculation_failed', now, code: error instanceof RuntimeStateError ? error.code : 'UNEXPECTED_ERROR' });
      // 事务失败保留上一份完整发布；不能留下部分时刻或半份评分。
      if (!published) return null;
      throw error;
    } finally { calculating = false; }
  }

  /** 结算到期的事后收益：退出价必须取自登记时的同一条序列，缺失则记为无结果而非换源。 */
  function settleOutcomes(now = opts.clock?.() ?? Date.now()): number {
    let settled = 0;
    for (const row of outcomes.pending(now)) {
      const target = row.baselineAt + row.horizonHours * HOUR_MS;
      let exit: number | null = null;
      if (row.seriesId) {
        // 容差 8 根：稀疏成交的资产在目标时刻可能无成交，取此前最近一根已收盘价。
        for (let back = 0; back < 8 && exit === null; back++) {
          const bar = seriesCloseAt(row.seriesId, target - back * INTERVAL_MS['15m']);
          if (bar !== null) exit = bar;
        }
      }
      if (outcomes.settle(row, exit, now)) settled++;
    }
    return settled;
  }
  const closeAtStmt = db.prepare(`SELECT close FROM series_candles
    WHERE series_id = ? AND interval = '15m' AND open_time = ?`);
  function seriesCloseAt(seriesId: string, closeTime: number): number | null {
    const row = closeAtStmt.get(seriesId, closeTime - INTERVAL_MS['15m']) as { close: number } | undefined;
    return row && Number.isFinite(row.close) && row.close > 0 ? row.close : null;
  }

  /** T 是统一收盘基准。重复调用只在同 T 的端点输入变化时发布下一修订。 */
  async function calculateAt(now: number): Promise<RoundReport | null> { return calculate(now, false); }

  /** 保留已有干跑/集成调用的固定 now 和串行语义。生产使用两个独立入口。 */
  async function runOnce(now = opts.clock?.() ?? Date.now()): Promise<RoundReport | null> {
    if (combinedRunning || collecting || discovering || calculating || stopping) return null;
    combinedRunning = true;
    try {
      const report = await collect(now, true);
      const collected = state.getCollectionRound();
      if (!report || !collected || (collected.status !== 'complete' && collected.status !== 'partial')) return report;
      return await calculate(now, true) ?? report;
    } finally { combinedRunning = false; }
  }
  return { runOnce, collectOnce, discoverOnce, collectKnownPoolOnce, calculateAt, settleOutcomes, stop: () => { stopping = true; } };
}

async function main() {
  const cfg = loadStrategy();
  const { config } = await import('../config.js');
  const db = openDatabase(config.databasePath);
  const quota = createQuotaGuard(db, cfg, Date.now, config.quotaTimezone);
  const telegram = new TelegramClient({ token: config.telegramBotToken, chatId: config.telegramChatId });
  const notifier = createNotifier({ db, cfg, dryRun: config.dryRun, publicSite: config.publicSite, send: (text) => telegram.send(text) });
  let markMarketData = () => {};
  const scheduler = createScheduler({ db, cfg, quota, notifier, clock: Date.now, onMarketData: () => markMarketData(),
    client: new ErwaClient({ baseUrl: config.erwaApiBase, token: config.erwaApiToken, onCall: quota.onCall }),
    // 直连 DexScreener 官方批量端点：30 个/批、60 req/min，且不消耗二娃配额
    dexBatch: new DexScreenerClient(),
    klineSource: new GeckoTerminalClient({ requestsPerMinute: cfg.kline.requestsPerMinute }),
    operationalAlert: async (text) => { if (config.dryRun) console.log(`[DRY_RUN] ${text}`); else await telegram.send(text); } });
  if (config.dryRun) {
    try { const report = await scheduler.runOnce(); if (report?.halted || !report?.poolComplete) process.exitCode = 1; }
    finally { db.close(); }
    return;
  }
  const runtime = createRuntimeStore(db);
  const gmgnKey = process.env.GMGN_API_KEY;
  const gmgnConfigured = configureGmgnAccess(db, cfg.kline.gmgn.enabled, gmgnKey, Date.now());
  const gmgnCollector = gmgnConfigured ? createGmgnCollector({ db, cfg,
    client: new GmgnClient({ apiKey: gmgnKey!, requestsPerMinute: cfg.kline.gmgn.requestsPerMinute }), clock: Date.now }) : null;
  if (cfg.kline.gmgn.enabled && !gmgnConfigured) console.error('GMGN 凭据未配置或格式无效，已暂停 GMGN 采集');
  const interval = cfg.schedule.mainLoopMinutes * MINUTE_MS;
  const baseline = () => Math.floor(Date.now() / interval) * interval;
  let lastSlot = -1;
  let closing = false;
  const coordinator = createCalculationCoordinator({ intervalMs: interval,
    revisionMs: cfg.schedule.revisionMinutes * MINUTE_MS, clock: Date.now,
    calculate: async (time) => {
      const report = await scheduler.calculateAt(time);
      if (report?.poolComplete) return true;
      const saved = runtime.getRound();
      return saved?.strategyKey === strategyKey(cfg) && saved.startedAt === time && saved.boardComplete
        && (saved.status === 'complete' || saved.status === 'partial');
    },
    log: (event) => console.error(JSON.stringify(event)),
  });
  markMarketData = () => coordinator.request('data');
  const requestCalculation = async (_time: number): Promise<void> => { coordinator.request('data'); };
  const tick = () => {
    const time = baseline();
    if (closing || time === lastSlot) return;
    lastSlot = time;
    coordinator.request('boundary');
  };
  let wakeCollector: (() => void) | null = null;
  const pauseCollection = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); wakeCollector = null; resolve(); }
    wakeCollector = done;
  });
  // 保留上游自身的串行节流。快速失败/空池也设最低间隔，禁止形成重试忙循环。
  const minCycle = Math.ceil(MINUTE_MS / Math.min(cfg.kline.requestsPerMinute, 10));
  const collectContinuously = async () => {
    while (!closing) {
      const started = Date.now();
      const blockedUntil = runtime.geckoRateLimitStore.getUntil();
      if (blockedUntil > started) {
        await pauseCollection(Math.min(blockedUntil - started, MINUTE_MS));
        continue;
      }
      try { await scheduler.collectKnownPoolOnce(started); } catch { console.error('行情采集失败'); }
      // 结算只读本地 K 线，不占用任何上游限速预算。
      try { const n = scheduler.settleOutcomes(Date.now()); if (n) console.log(JSON.stringify({ event: 'outcomes_settled', count: n })); }
      catch { console.error('事后收益结算失败'); }
      if (closing) break;
      // 同一固定 T 允许迟到行情补齐；无新增端点的请求被输入指纹去重。
      void requestCalculation(baseline());
      const cooldown = runtime.geckoRateLimitStore.getUntil();
      const delay = Math.max(minCycle - (Date.now() - started), cooldown - Date.now());
      if (delay > 0) await pauseCollection(Math.min(delay, MINUTE_MS));
    }
  };
  let lastDiscoverySlot = -1;
  let discovery: Promise<void> | null = null;
  const discoveryTick = () => {
    const now = Date.now();
    const slot = Math.floor(now / (cfg.pool.refreshMinutes * MINUTE_MS));
    if (closing || discovery || slot === lastDiscoverySlot) return;
    lastDiscoverySlot = slot;
    discovery = (async () => {
      try {
        const report = await scheduler.discoverOnce(now);
        if (report?.poolComplete) {
          // 首次有效观察池可立即计算；后续发现更新与两家行情共享同 T 修订节流。
          coordinator.request('observation');
          wakeCollector?.();
        }
      } catch { console.error('观察池发现失败'); }
    })().finally(() => { discovery = null; });
  };
  let wakeGmgn: (() => void) | null = null;
  const pauseGmgn = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); wakeGmgn = null; resolve(); }
    wakeGmgn = done;
  });
  const task = cron.schedule('* * * * *', () => { tick(); discoveryTick(); });
  // 独立启动三个流程：群发现、现有库评分、公平行情轮询。
  tick(); discoveryTick();
  const collector = collectContinuously();
  const gmgnCollection = gmgnCollector ? runGmgnCollectionLoop({ collector: gmgnCollector,
    intervalMs: interval, clock: Date.now, stopped: () => closing, sleep: pauseGmgn, requestCalculation,
    log: (event) => console.log(JSON.stringify(event)) }) : Promise.resolve();
  const shutdown = async () => {
    if (closing) return;
    closing = true; scheduler.stop(); gmgnCollector?.stop(); wakeCollector?.(); wakeGmgn?.();
    const finishingCalculation = coordinator.stop();
    await task.destroy(); await collector; await gmgnCollection; await discovery; await finishingCalculation; db.close();
  };
  process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    if (error instanceof StrategyConfigError) console.error(error.message);
    else {
      // 通用文案会掩盖真实原因；打印错误类型与消息（不含堆栈细节里的密钥）
      console.error('启动失败，请检查环境、策略配置和数据库');
      console.error(`原因: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    }
    process.exitCode = 1;
  });
}
