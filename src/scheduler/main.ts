import cron from 'node-cron';
import { pathToFileURL } from 'node:url';
import { canonicalCa, isQueryableCa } from '../addresses.js';
import { DexScreenerClient } from '../api/dexscreener.js';
import { GeckoTerminalClient, GeckoTerminalError } from '../api/geckoterminal.js';
import { ErwaClient, ErwaError } from '../api/erwa.js';
import { assertPoolCapacity, loadStrategy, StrategyConfigError, type StrategyConfig } from '../config/strategy.js';
import { calculateObservationRps } from '../indicators/observation-rps.js';
import { INTERVAL_MS, MINUTE_MS, PERIODS, PERIOD_MS, closedCandles, contiguousTail, emptyScores } from '../market.js';
import { aggregateCandles } from '../indicators/merge.js';
import { rsi } from '../indicators/rsi.js';
import { sma } from '../indicators/sma.js';
import { createNotifier, TelegramClient, TelegramError } from '../notify/telegram.js';
import { PoolSelectionError, selectObservationPool } from '../pool/select.js';
import { evaluate, type RuleOutput } from '../rules/evaluate.js';
import { checkPreconditions } from '../rules/preconditions.js';
import { createCandleStore } from '../store/candles.js';
import { openDatabase, type StoreDatabase } from '../store/db.js';
import { createMomentStore } from '../store/moments.js';
import { createPoolStore } from '../store/pool.js';
import { createRuntimeStore, initialRound, pendingMember, RuntimeStateError, type RoundMember } from '../store/runtime.js';
import { readRoundInputs } from '../store/snapshot.js';
import type { BoardPoolItem, DexSnapshot, Range } from '../types.js';
import { createQuotaGuard, QuotaStopError } from './quota.js';

type DataClient = Pick<ErwaClient, 'getBoardSummary' | 'getDexScreener' | 'getKline' | 'getTokenUsage'>
  & Partial<Pick<ErwaClient, 'setRateLimitStore'>>;
type QuotaGuard = ReturnType<typeof createQuotaGuard>;
type Notifier = ReturnType<typeof createNotifier>;
export interface RoundReport {
  now: number; poolSize: number; candidateCount: number; poolComplete: boolean; failures: number; degraded: boolean; halted: boolean;
  results: { ca: string; result: RuleOutput }[];
}

export function createScheduler(opts: { db: StoreDatabase; cfg: StrategyConfig; client: DataClient;
  quota: QuotaGuard; notifier: Notifier; log?: (event: Record<string, unknown>) => void;
  clock?: () => number; operationalAlert?: (message: string) => Promise<void>;
  /** 提供时走 DexScreener 官方批量端点（30 个/批，不消耗二娃配额）；省略则逐个回退 */
  dexBatch?: Pick<DexScreenerClient, 'getAll'>;
  /** K 线主源；省略则回退到二娃的 getKline */
  klineSource?: Pick<GeckoTerminalClient, 'getCandles15m'> }) {
  const { db, cfg, client, quota, notifier } = opts;
  assertPoolCapacity(cfg);
  const poolStore = createPoolStore(db);
  const candles = createCandleStore(db);
  const moments = createMomentStore(db);
  const log = opts.log ?? ((event) => console.log(JSON.stringify(event)));
  let currentNow = 0;
  const clock = () => opts.clock?.() ?? currentNow;
  const state = createRuntimeStore(db, clock);
  client.setRateLimitStore?.(state.rateLimitStore);
  let running = false;
  let stopping = false;

  async function runOnce(now = opts.clock?.() ?? Date.now()): Promise<RoundReport | null> {
    if (running || stopping) { log({ event: 'round_skipped', reason: stopping ? 'stopping' : 'already_running' }); return null; }
    currentNow = now;
    running = true;
    const snapshot = initialRound(cfg, now);
    const previous = state.getRound();
    if (previous?.strategyKey === snapshot.strategyKey) snapshot.members = previous.members.map((member) => ({
      ...member, qualified: false, rpsScores: emptyScores(), result: null, dexStatus: 'pending', klineStatus: 'skipped',
    }));
    const report: RoundReport = { now, poolSize: 0, candidateCount: 0, poolComplete: false, failures: 0,
      degraded: false, halted: false, results: [] };
    const failure = (stage: string, error: unknown, ca?: string) => {
      snapshot.failures++;
      log({ event: 'request_failed', stage, ...(ca ? { ca } : {}), code: error instanceof ErwaError || error instanceof QuotaStopError
        || error instanceof TelegramError || error instanceof PoolSelectionError || error instanceof RuntimeStateError
        || error instanceof StrategyConfigError || error instanceof GeckoTerminalError ? error.code : 'UNEXPECTED_ERROR' });
    };
    const halted = () => stopping || quota.state(clock()).halted || state.rateLimitStore.getUntil() > clock();
    async function syncUsage(stage: string) {
      const remote = await client.getTokenUsage();
      quota.sync(remote.usedToday, remote.dailyLimit, clock());
      assertPoolCapacity(cfg, remote.dailyLimit);
      snapshot.quota = { used: quota.state(clock()).used, limit: quota.state(clock()).limit };
      log({ event: 'usage_checked', stage, usedToday: remote.usedToday, remainingToday: remote.remainingToday });
      return remote;
    }
    try {
      state.saveRound(snapshot);
      if (halted()) { snapshot.status = 'halted'; return report; }
      try { await syncUsage('round_start'); }
      catch (error) { failure('usage', error); snapshot.status = 'halted'; return report; }
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
        pool.listedAt = state.getListing(item.ca);
        return pendingMember(pool, item.totalMentions);
      });
      state.saveRound(snapshot);
      log({ event: 'pool_selected', sourceCount: selected.sourceCount, poolSize: snapshot.members.length,
        maxCandidates: cfg.pool.maxCandidates, sourceLimited: selected.sourceLimited, rankBy: cfg.pool.rankBy });

      if (snapshot.members.length) {
        try { await syncUsage('before_dex'); }
        catch (error) { failure('usage_before_dex', error); snapshot.status = 'halted'; return report; }
        // 批量优先：官方端点 30 个/批，495 个 CA 仅需约 23 次请求（逐个则 495 次）
        const batched = opts.dexBatch
          ? await opts.dexBatch.getAll(snapshot.members.map((member) => ({ ca: member.pool.ca, chain: member.pool.chain })))
              .catch((error: unknown) => { failure('dex_batch', error); return new Map<string, DexSnapshot>(); })
          : null;
        const applyDex = (member: RoundMember, snap: DexSnapshot | undefined) => {
          if (snap) {
            member.dex = snap;
            member.dexAt = clock();
            member.dexStatus = 'ok';
            const created = snap.pairCreatedAt;
            if (member.pool.listedAt === null && created !== null && created <= now) member.pool.listedAt = state.cacheListing(member.pool.ca, created);
          }
          // A2 复用 summary 已提供的精确市值/流动性；不为 A2 额外请求行情。
          const gates = checkPreconditions({ pool: member.pool, listedAt: member.pool.listedAt, now }, cfg);
          member.qualified = gates.a1 && gates.a2;
          poolStore.setListedAt(member.pool.ca, member.pool.listedAt);
        };
        if (batched) {
          for (const member of snapshot.members) {
            const snap = batched.get(canonicalCa(member.pool.ca));
            if (!snap) member.dexStatus = 'error';
            applyDex(member, snap);
          }
        } else {
          let next = 0;
          async function dexWorker() {
            while (next < snapshot.members.length && !halted()) {
              const member = snapshot.members[next++]!;
              let snap: DexSnapshot | undefined;
              try { snap = await client.getDexScreener(member.pool.ca); }
              catch (error) { member.dexStatus = 'error'; failure('dex', error, member.pool.ca); }
              applyDex(member, snap);
            }
          }
          await Promise.all([dexWorker(), dexWorker()]);
        }
        state.saveRound(snapshot);
        try { await syncUsage('after_dex'); }
        catch (error) { failure('usage_after_dex', error); snapshot.status = 'halted'; return report; }
      }
      if (halted()) { snapshot.status = 'halted'; return report; }
      const round = Math.floor(now / (cfg.schedule.mainLoopMinutes * MINUTE_MS));
      for (const member of snapshot.members) {
        if (!member.qualified) continue;
        if (halted()) { snapshot.status = 'halted'; return report; }
        const refresh = cfg.schedule.klineRefresh;
        // 群聊里混入的残缺 EVM 地址查行情必然失败，却照样消耗配额 —— 本地直接跳过
        if (!isQueryableCa(member.pool.ca)) {
          member.klineStatus = 'error';
          log({ event: 'kline_skipped', ca: member.pool.ca, reason: 'malformed_evm_address' });
          continue;
        }
        // 主源：GeckoTerminal。只拉 15m（1000 根≈10.5 天），30m/1h/4h 全部本地合成 ——
        // 一个 CA 一次请求，且不占二娃额度。二娃按链有无数据（robinhood 等完全没有），
        // 历史也只有 24 小时，会让 A3.1 与 A3.2 塌缩，故仅作回退。
        const pool = member.dex?.pairAddress;
        const network = member.dex?.chainId;
        if (opts.klineSource && pool && network) {
          member.klineStatus = 'ready';
          try {
            const bars = await opts.klineSource.getCandles15m(network, pool, cfg.kline.bars15m);
            if (bars.length) {
              candles.upsertCandles(member.pool.ca, '15m', bars);
              candles.upsertCandles(member.pool.ca, '1h', aggregateCandles(bars, INTERVAL_MS['15m'], INTERVAL_MS['1h']));
              candles.upsertCandles(member.pool.ca, '4h', aggregateCandles(bars, INTERVAL_MS['15m'], INTERVAL_MS['4h']));
              continue;
            }
            member.klineStatus = 'error';
          } catch (error) { failure('kline_gecko', error, member.pool.ca); member.klineStatus = 'error'; }
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
      const inputs = readRoundInputs(db, cfg, now, snapshot.members);
      const ranking = calculateObservationRps(inputs.map((input, i) => ({ ca: input.ca, listedAt: input.listedAt,
        candles15m: input.candles15m, candles60m: input.candles60m, dex: snapshot.members[i]!.dex, dexStatus: snapshot.members[i]!.dexStatus })), now, cfg);
      snapshot.coverage = ranking.coverage;
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i]!;
        const member = snapshot.members[i]!;
        member.rpsScores = ranking.scores.get(input.ca) ?? emptyScores();
        input.rpsScores = member.rpsScores;
        if (!member.qualified || member.klineStatus !== 'ready') {
          input.candles30m = []; input.candles60m = []; input.candles4h = [];
        }
        const result = evaluate(input);
        member.result = result;
        moments.upsertMoments(input.ca, result.newMoments, now);
        report.results.push({ ca: input.ca, result });
        log({ event: 'evaluate', ca: input.ca, symbol: input.pool.symbol, listedAt: input.listedAt, qualified: member.qualified,
          reasons: result.reasons, rpsScores: input.rpsScores, tags: result.tags, newMoments: result.newMoments.length });
        const frames = { '30m': input.candles30m, '60m': input.candles60m, '4h': input.candles4h };
        const indicators = Object.fromEntries(PERIODS.map((period) => {
          const bars = contiguousTail(closedCandles(frames[period], PERIOD_MS[period], now), PERIOD_MS[period]);
          return [period, { candle: bars.at(-1) ?? null, rsi: rsi(bars, cfg.indicators.rsiPeriod).at(-1) ?? null,
            volumeMa: sma(bars.map((bar) => bar.volume), cfg.supplementary.volMaPeriod).at(-1) ?? null }];
        }));
        try { await notifier.notify({ ca: input.ca, pool: input.pool, now, tags: result.tags, rpsScores: input.rpsScores,
          payload: { reasons: result.reasons, listedAt: input.listedAt, listingSource: 'dex', strategyVersion: cfg.version,
            newMoments: result.newMoments, indicators, dex: member.dex, rpsCoverage: ranking.coverage } }); }
        catch (error) { failure('notify', error, input.ca); }
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
        for (const member of snapshot.members) { member.rpsScores = emptyScores(); member.result = null; }
        for (const coverage of Object.values(snapshot.coverage)) coverage.complete = false;
      }
      try { state.saveRound(snapshot); } finally { running = false; }
      log({ event: 'round_complete', now, poolSize: report.poolSize, candidateCount: report.candidateCount,
        sourceCount: snapshot.sourceCount, sourceLimited: snapshot.sourceLimited, poolComplete: report.poolComplete,
        evaluated: report.results.length, failures: report.failures, degraded: report.degraded, halted: report.halted, rpsCoverage: snapshot.coverage });
      if (report.halted && !stopping) {
        try { await opts.operationalAlert?.('Alpha-Reset：配额保护、查询失败或账号限流，本轮停止拉取。'); }
        catch (error) { log({ event: 'operational_alert_failed', code: error instanceof TelegramError ? error.code : 'UNEXPECTED_ERROR' }); }
      }
    }
  }
  return { runOnce, stop: () => { stopping = true; } };
}

async function main() {
  const cfg = loadStrategy();
  const { config } = await import('../config.js');
  const db = openDatabase(config.databasePath);
  const quota = createQuotaGuard(db, cfg, Date.now, config.quotaTimezone);
  const telegram = new TelegramClient({ token: config.telegramBotToken, chatId: config.telegramChatId });
  const notifier = createNotifier({ db, cfg, dryRun: config.dryRun, publicSite: config.publicSite, send: (text) => telegram.send(text) });
  const scheduler = createScheduler({ db, cfg, quota, notifier, clock: Date.now,
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
  let lastSlot = -1;
  let closing = false;
  let active: Promise<void> = Promise.resolve();
  const tick = () => {
    if (closing) return active;
    const now = Date.now();
    const slot = Math.floor(now / (cfg.schedule.mainLoopMinutes * MINUTE_MS));
    if (slot === lastSlot) return active;
    lastSlot = slot;
    active = (async () => { try { await scheduler.runOnce(now); } catch { console.error('调度轮次失败'); } })();
    return active;
  };
  const task = cron.schedule('* * * * *', tick, { noOverlap: true });
  const shutdown = async () => { if (closing) return; closing = true; scheduler.stop(); await task.destroy(); await active; db.close(); };
  process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
  await tick();
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
