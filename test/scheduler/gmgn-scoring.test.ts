import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { loadStrategy } from '../../src/config/strategy.js';
import { aggregateCandles } from '../../src/indicators/merge.js';
import { INTERVAL_MS, PERIOD_MS, RPS_KEYS } from '../../src/market.js';
import type { Notification } from '../../src/notify/telegram.js';
import { configureGmgnAccess, createScheduler, runGmgnCollectionLoop } from '../../src/scheduler/main.js';
import { gmgnReadiness, type SeriesHistory } from '../../src/scheduler/gmgn-readiness.js';
import { createQuotaGuard } from '../../src/scheduler/quota.js';
import { openDatabase } from '../../src/store/db.js';
import { createPoolStore } from '../../src/store/pool.js';
import { createRuntimeStore, initialRound, pendingMember } from '../../src/store/runtime.js';
import { createSeriesStore, type MarketSeries } from '../../src/store/series.js';
import { readRoundInputs } from '../../src/store/snapshot.js';
import type { Candle, DexSnapshot } from '../../src/types.js';
import { candle, poolItem, SAMPLE_STRATEGY } from '../helpers.js';

const T = 100 * INTERVAL_MS['1d'];
const STEP = INTERVAL_MS['15m'];
const SLOT = 30 * 60_000;
function history(until = T, count = 800, start = 100): Candle[] {
  return Array.from({ length: count }, (_, i) => candle(until - (count - i) * STEP, start + i));
}
function frames(bars: Candle[]): SeriesHistory {
  return { candles15m: bars, candles60m: aggregateCandles(bars, STEP, INTERVAL_MS['1h']),
    candles4h: aggregateCandles(bars, STEP, INTERVAL_MS['4h']) };
}
function fixture(t: TestContext, members: { ca: string; chain: string }[] = [{ ca: 'a', chain: 'solana' }]) {
  const db = openDatabase(':memory:'); t.after(() => { if (db.open) db.close(); });
  const cfg = loadStrategy(SAMPLE_STRATEGY); cfg.kline.gmgn.enabled = true;
  cfg.kline.gmgn.chains = ['sol', 'bsc', 'base', 'eth', 'robinhood'];
  let now = T; const clock = () => now;
  const state = createRuntimeStore(db, clock); const series = createSeriesStore(db);
  const pool = createPoolStore(db); const quota = createQuotaGuard(db, cfg, clock);
  const notifications: Notification[] = []; const geckoCalls: string[] = [];
  const round = initialRound(cfg, T); round.boardComplete = true; round.status = 'complete'; round.completedAt = T;
  for (const { ca, chain } of members) {
    pool.upsertPool([poolItem(ca, { chain })], T);
    const listedAt = T - 60 * INTERVAL_MS['1d'];
    state.cacheListing(ca, listedAt, chain);
    const member = pendingMember({ ...pool.getPoolItem(ca)!, listedAt }, 1);
    const dex: DexSnapshot = { pairAddress: 'pool-' + ca, chainId: chain, priceUsd: 100,
      marketCap: 100_000, liquidityUsd: 50_000, pairCreatedAt: listedAt,
      priceChange: { m5: null, h1: null, h6: null, h24: null } };
    member.dex = dex; member.dexAt = T; member.dexStatus = 'ok'; member.seriesId = null;
    round.members.push(member);
  }
  state.saveObservationRound(round);
  const make = () => createScheduler({ db, cfg, quota, clock, log: () => {},
    notifier: { async notify(value) { notifications.push(value); return { tags: value.tags, messages: 0 }; } },
    client: {
      async getTokenUsage() { return { usedToday: 0, remainingToday: 10_000, dailyLimit: 10_000 }; },
      async getBoardSummary() { return []; }, async getKline() { return assert.fail('no Erwa candles'); },
      async getDexScreener() { return assert.fail('no Dex HTTP during local calculation'); },
    },
    klineSource: { async getCandles15m(_network, _pool, _limit, ca) { geckoCalls.push(ca!); return history(now); } },
  });
  function write(identity: MarketSeries, bars: Candle[]) {
    const values = frames(bars);
    series.upsertCandles(identity.id, '15m', values.candles15m);
    series.upsertCandles(identity.id, '1h', values.candles60m);
    series.upsertCandles(identity.id, '4h', values.candles4h);
  }
  function add(source: 'geckoterminal' | 'gmgn', ca = 'a', network = 'solana', bars = history(), active = source === 'geckoterminal') {
    const common = { network, ca, currency: 'usd' as const, formatVersion: 1 };
    const identity = source === 'gmgn'
      ? series.ensureSeries({ ...common, source, scope: 'token', poolAddress: null }, now)
      : series.ensureSeries({ ...common, source, poolAddress: 'pool-' + ca }, now);
    write(identity, bars);
    return active ? series.activateSeries(identity.id, now) : identity;
  }
  return { db, cfg, state, series, round, notifications, geckoCalls, make, add, write, setNow(value: number) { now = value; } };
}

test('纯准备度要求同T准确端点，未知龄不跳长窗口，已证实年轻币不要求不存在的历史', () => {
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  const previous = frames(history()); const full = frames(history());
  const input = { cfg, now: T, listedAt: null, previous, candidate: full };
  assert.equal(gmgnReadiness(input).ready, true);
  const longTarget = T - cfg.a4_rps.periods.r672.bars * STEP;
  const noLong = frames(history().filter((bar) => bar.openTime + STEP !== longTarget));
  // 同源 1h 恰好补有该端点时也有效；同时删掉它才能模拟真实缺失。
  noLong.candles60m = noLong.candles60m.filter((bar) => bar.openTime + INTERVAL_MS['1h'] !== longTarget);
  const unknown = gmgnReadiness({ ...input, candidate: noLong });
  assert.equal(unknown.ready, false); assert.ok(unknown.missingStarts.includes('r672'));
  const noCurrent = frames(history().slice(0, -1));
  assert.equal(gmgnReadiness({ ...input, candidate: noCurrent }).missingCurrent, true);
  const young = frames(history(T, 40));
  assert.equal(gmgnReadiness({ ...input, candidate: young, previous: young, listedAt: T - 40 * STEP }).ready, true);
  assert.equal(gmgnReadiness({ ...input, candidate: young, previous: young, listedAt: null }).ready, false);
  assert.equal(gmgnReadiness({ ...input, candidate: frames(history(T - SLOT, 2)), previous: null }).ready, true);
});

test('候选端点齐全但突破周期不足不能替换已有49根连续历史，缺口也不算连续', () => {
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  const previous = frames(history());
  const candidate = frames(history(T, 673));
  const result = gmgnReadiness({ candidate, previous, listedAt: T - 60 * INTERVAL_MS['1d'], now: T, cfg });
  assert.deepEqual(result.missingStarts, []); assert.equal(result.missingCurrent, false);
  assert.ok(result.missingPeriods.includes('4h')); assert.equal(result.ready, false);
  const holes = frames(history());
  holes.candles4h = holes.candles4h.filter((bar) => bar.openTime !== T - 4 * PERIOD_MS['4h']);
  assert.ok(gmgnReadiness({ candidate: holes, previous, listedAt: null, now: T, cfg }).missingPeriods.includes('4h'));
  const stalePeriod = frames(history());
  stalePeriod.candles60m.pop();
  assert.ok(gmgnReadiness({ candidate: stalePeriod, previous, listedAt: null, now: T, cfg }).missingPeriods.includes('60m'));
});

test('已有Gecko同T补齐GMGN不切换，下一T达标后原子切源，收益和高点只读GMGN', async (t) => {
  const f = fixture(t); const gecko = f.add('geckoterminal'); const scheduler = f.make();
  await scheduler.calculateAt(T);
  assert.equal(f.state.getRound()!.members[0]!.seriesId, gecko.id);
  f.setNow(T + 10_000);
  const gmgn = f.add('gmgn', 'a', 'solana', history(T, 800, 1000));
  assert.equal(await scheduler.calculateAt(T), null);
  assert.equal(f.series.getActive('solana', 'a')!.id, gecko.id);
  f.series.upsertMoments(gecko.id, [{ moment: 1, barTime: 0, price: 999_999 }], T);
  f.setNow(T + SLOT + 5_000);
  f.write(gmgn, history(T + SLOT, 800, 1000));
  assert.ok(await scheduler.calculateAt(T + SLOT));
  const switched = f.state.getRound()!;
  assert.equal(switched.members[0]!.seriesId, gmgn.id);
  assert.equal(switched.members[0]!.plannedSource, 'gmgn');
  assert.equal(f.series.getActive('solana', 'a')!.id, gmgn.id);
  assert.equal(f.series.getSeries(gecko.id)!.active, false);
  const input = readRoundInputs(f.db, f.cfg, T + SLOT, switched.members)[0]!;
  assert.equal(input.candles15m.at(-1)!.close, history(T + SLOT, 800, 1000).at(-1)!.close);
  assert.ok(input.moments.every((moment) => moment.price < 999_999));
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM market_series_switches').get() as { n: number }).n, 1);
});

test('新T候选历史不达标继续Gecko；未知年龄或漏长端点不得提前接正式评分', async (t) => {
  const f = fixture(t); const gecko = f.add('geckoterminal'); const candidate = f.add('gmgn', 'a', 'solana', history(T, 100));
  const scheduler = f.make();
  await scheduler.calculateAt(T);
  assert.equal(f.state.getRound()!.members[0]!.seriesId, gecko.id);
  assert.equal(f.series.getSeries(candidate.id)!.active, false);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM market_series_switches').get() as { n: number }).n, 0);
});

test('同T非空seriesId严格固定，active外部变更也不更换；首次null只绑定预定GMGN', async (t) => {
  const f = fixture(t); const scheduler = f.make();
  await scheduler.calculateAt(T);
  assert.equal(f.state.getRound()!.members[0]!.seriesId, null);
  assert.equal(f.state.getRound()!.members[0]!.plannedSource, 'gmgn');
  f.setNow(T + 5_000);
  const gmgn = f.add('gmgn', 'a', 'solana', history(T, 100));
  assert.ok(await scheduler.calculateAt(T));
  const bound = f.state.getRound()!;
  assert.equal(bound.members[0]!.seriesId, gmgn.id);
  assert.equal(bound.coverage.r16.available, 1);
  assert.equal(bound.coverage.r672.available, 0);
  assert.equal(bound.coverage.r672.eligible, 1);
  // 用管理操作模拟外部active改变，本轮仍读已冻结token序列。
  const gecko = f.add('geckoterminal', 'a', 'solana', history(), false);
  f.series.switchActiveSeries(gecko.id, gmgn.id, T + 5_000, 'test_external_switch');
  f.write(gmgn, history(T, 100, 200));
  assert.ok(await scheduler.calculateAt(T));
  assert.equal(f.state.getRound()!.members[0]!.seriesId, gmgn.id);
  assert.equal(f.state.getRound()!.members[0]!.plannedSource, 'gmgn');
});

test('GMGN已active后缺当期端点仍保留来源和全池分母，不fallback到新鲜Gecko', async (t) => {
  const f = fixture(t, [{ ca: 'a', chain: 'solana' }, { ca: 'b', chain: 'solana' }]);
  const a = f.add('gmgn', 'a', 'solana', history(), true);
  f.add('gmgn', 'b', 'solana', history(T + SLOT), true);
  f.add('geckoterminal', 'a', 'solana', history(T + SLOT), false);
  f.setNow(T + SLOT);
  await f.make().calculateAt(T + SLOT);
  const round = f.state.getRound()!;
  assert.equal(round.members[0]!.seriesId, a.id);
  assert.equal(round.coverage.r16.eligible, 2); assert.equal(round.coverage.r16.available, 1);
  assert.equal(round.coverage.r16.missingCurrent, 1);
  assert.equal(round.members[0]!.rpsScores.r16, null); assert.deepEqual(round.members[0]!.result!.tags, []);
});

test('Gecko队列不抢GMGN支持的新CA或activeGMGN，已有Gecko和不支持链继续采集', async (t) => {
  const f = fixture(t, [{ ca: 'pending', chain: 'solana' }, { ca: 'gmgn', chain: 'solana' },
    { ca: 'gecko', chain: 'solana' }, { ca: 'unsupported', chain: 'avax' }]);
  f.add('gmgn', 'gmgn', 'solana', history(), true);
  f.add('geckoterminal', 'gecko', 'solana');
  await f.make().collectKnownPoolOnce(T);
  assert.deepEqual(f.geckoCalls.sort(), ['gecko', 'unsupported']);
  assert.equal(f.series.getActive('solana', 'pending'), null);
  assert.equal(f.series.getActive('avax', 'unsupported')!.source, 'geckoterminal');
  assert.equal(f.notifications.length, 0);
});

test('GMGN配置缺失只暂停自身；重启相同凭据保持认证暂停，换凭据仅清认证错误', (t) => {
  const f = fixture(t);
  assert.equal(configureGmgnAccess(f.db, true, undefined, T), false);
  const payload = (key: string) => (f.db.prepare('SELECT payload FROM runtime_state WHERE key=?').get(key) as { payload: string } | undefined)?.payload;
  assert.equal(JSON.parse(payload('gmgn_status')!).reason, 'missing_api_key');
  const old = 'test_gmgn_old'; const next = 'test_gmgn_new';
  assert.equal(configureGmgnAccess(f.db, true, old, T), true);
  for (const [key, value] of [['gmgn_auth_error', { httpStatus: 401, at: T }],
    ['gmgn_cooldown', { until: T + SLOT }], ['gmgn_state', { cursor: 5 }]] as const) {
    f.db.prepare('INSERT INTO runtime_state VALUES (?,?,?)').run(key, JSON.stringify(value), T);
  }
  assert.equal(configureGmgnAccess(f.db, true, old, T + 1), true);
  assert.ok(payload('gmgn_auth_error'));
  assert.equal(configureGmgnAccess(f.db, true, next, T + 2), true);
  assert.equal(payload('gmgn_auth_error'), undefined);
  assert.deepEqual(JSON.parse(payload('gmgn_state')!), { cursor: 5 });
  assert.deepEqual(JSON.parse(payload('gmgn_cooldown')!), { until: T + SLOT });
  assert.ok(!payload('gmgn_credential')!.includes(old)); assert.ok(!payload('gmgn_credential')!.includes(next));
  assert.equal(configureGmgnAccess(f.db, false, next, T + 3), false);
});

test('GMGN独立循环仅报告变更给共享协调器，通知未完成不阻断采集，长冷却分段等待不忙转', async () => {
  let now = T; let stopped = false; let calls = 0;
  const calculations: number[] = []; const sleeps: number[] = [];
  const pending = new Promise<void>(() => {});
  await runGmgnCollectionLoop({ intervalMs: SLOT, clock: () => now, stopped: () => stopped,
    collector: { async collectOnce() { calls++; return { attempted: true, changed: true,
      nextAt: calls < 3 ? now + 5_000 : now + 5 * 60_000 }; } },
    requestCalculation: async (baseline) => { calculations.push(now); assert.equal(baseline, T); return pending; },
    sleep: async (ms) => { sleeps.push(ms); now += ms; if (now >= T + 90_000) stopped = true; },
  });
  assert.equal(calls, 3);
  assert.deepEqual(calculations, [T, T + 5_000, T + 10_000]);
  assert.ok(sleeps.every((ms) => ms > 0 && ms <= 60_000));
  assert.ok(sleeps.length <= 6);
});

test('成熟GMGN在新T先预定null，端点迟到后首次绑定；混合池发布不丢旧Gecko展示时间', async (t) => {
  const f = fixture(t, [{ ca: 'a', chain: 'solana' }, { ca: 'b', chain: 'solana' }]);
  const gecko = f.add('geckoterminal', 'a', 'solana', history());
  const other = f.add('geckoterminal', 'b', 'solana', history(T, 800, 200));
  const candidate = f.add('gmgn', 'a', 'solana', history());
  // 原T已经选择Gecko，模拟预热完成后的下一计算时点。
  f.cfg.kline.gmgn.enabled = false;
  const disabledRound = { ...f.round, strategyKey: initialRound(f.cfg, T).strategyKey };
  f.state.saveObservationRound(disabledRound);
  const disabledScheduler = f.make();
  await disabledScheduler.calculateAt(T);
  const previous = f.state.getRpsRound()!;
  f.cfg.kline.gmgn.enabled = true;
  const key = initialRound(f.cfg, T).strategyKey;
  previous.strategyKey = key;
  f.state.saveRound(previous);
  f.state.saveObservationRound({ ...f.round, strategyKey: key });
  f.setNow(T + SLOT);
  // 为新T的各起点及历史补齐，但缺T本身最后一个15m端点。
  f.write(candidate, history(T + SLOT - STEP));
  f.write(other, history(T + SLOT, 800, 200));
  const scheduler = f.make();
  assert.ok(await scheduler.calculateAt(T + SLOT));
  const waiting = f.state.getRound()!;
  assert.equal(waiting.members[0]!.seriesId, null);
  assert.equal(waiting.members[0]!.plannedSource, 'gmgn');
  assert.equal(f.series.getActive('solana', 'a')!.id, gecko.id);
  assert.deepEqual(waiting.members[0]!.result!.tags, []);
  assert.equal(waiting.coverage.r16.available, 1);
  assert.equal(f.state.getRpsRound()!.startedAt, T + SLOT, '另一个成员有值会更新普通展示缓存');
  const saved = f.state.getRpsFallbackRound(gecko.id)!;
  assert.equal(saved.startedAt, T); assert.equal(saved.completedAt, previous.completedAt);
  assert.equal(saved.originalPoolSize, 2); assert.equal(saved.members.length, 1);
  assert.deepEqual(saved.members[0]!.rpsScores, previous.members[0]!.rpsScores);
  f.setNow(T + SLOT + 10_000);
  f.write(candidate, history(T + SLOT));
  assert.ok(await scheduler.calculateAt(T + SLOT));
  assert.equal(f.state.getRound()!.members[0]!.seriesId, candidate.id);
  assert.equal(f.series.getActive('solana', 'a')!.id, candidate.id);
  assert.equal(f.state.getRpsFallbackRound(gecko.id)!.startedAt, T);
});

test('生产计算遇已有不兼容active只让该成员未知，不抢占且不拖垮全池', async (t) => {
  const f = fixture(t, [{ ca: 'a', chain: 'solana' }, { ca: 'b', chain: 'solana' }]);
  const incompatible = f.series.ensureSeries({ source: 'erwa', network: 'solana', ca: 'a',
    poolAddress: 'legacy-pool', currency: 'usd', formatVersion: 1 }, T);
  f.write(incompatible, history()); f.series.activateSeries(incompatible.id, T);
  f.add('gmgn', 'a', 'solana', history());
  f.add('geckoterminal', 'b', 'solana', history());
  assert.ok(await f.make().calculateAt(T));
  const round = f.state.getRound()!;
  assert.equal(round.members[0]!.seriesId, null);
  assert.equal(round.coverage.r16.eligible, 2); assert.equal(round.coverage.r16.available, 1);
  assert.equal(f.series.getActive('solana', 'a')!.id, incompatible.id);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM market_series_switches').get() as { n: number }).n, 0);
});

test('空或只有未收盘bar的GMGN候选不是成熟历史，不能撤下可用Gecko', async (t) => {
  for (const bars of [[], history(T + STEP, 1)]) {
    const f = fixture(t); const active = f.add('geckoterminal');
    const candidate = f.add('gmgn', 'a', 'solana', bars);
    const readiness = gmgnReadiness({ candidate: frames(bars), previous: frames(history()), listedAt: null, now: T, cfg: f.cfg });
    assert.equal(readiness.historyReady, false); assert.equal(readiness.ready, false);
    assert.ok(await f.make().calculateAt(T));
    const member = f.state.getRound()!.members[0]!;
    assert.equal(member.seriesId, active.id); assert.equal(member.plannedSource, 'geckoterminal');
    assert.equal(f.series.getActive('solana', 'a')!.id, active.id);
    assert.equal(f.series.getSeries(candidate.id)!.active, false);
  }
});

test('采集循环的最小间隔可配置，默认仍是 1 秒', async () => {
  // 采集器每次都要求立刻再来一次，实际节奏就由循环的最小间隔决定。
  // Binance 的 600 次/分钟预算被写死的 1 秒地板压成 60 次/分钟，历史回补会慢几倍。
  const run = async (minGapMs?: number) => {
    let now = T; let stopped = false; let calls = 0;
    const sleeps: number[] = [];
    await runGmgnCollectionLoop({
      intervalMs: SLOT, clock: () => now, stopped: () => stopped,
      collector: { async collectOnce() { calls++; if (calls >= 4) stopped = true; return { attempted: true, changed: false, nextAt: now }; } },
      requestCalculation: async () => {},
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
      ...(minGapMs === undefined ? {} : { minGapMs }),
    });
    return sleeps;
  };
  assert.deepEqual(await run(), [1_000, 1_000, 1_000], '不传时必须保持原有 1 秒节奏');
  assert.deepEqual(await run(200), [200, 200, 200], 'minGapMs 应能放开最小间隔');
});

test('旧来源同样缺失的窗口起点不阻塞换源', () => {
  // 低流动性代币在某个精确 15m 区间没有成交，两个来源都不会有那根收盘价。
  // 实测 62 个被判缺起点的成员里 55 个属于这种情况：该档位在旧来源同样算不出来，
  // 要求候选补上一根连现任都没有的 K 线是不可能满足的条件，只会把迁移永久卡死。
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  const bars = history();
  const gapIndex = bars.length - (cfg.a4_rps.periods.r672.bars + 1);
  const holed = bars.filter((_, index) => index !== gapIndex);

  const both = gmgnReadiness({ candidate: frames(holed), previous: frames(holed), listedAt: null, now: T, cfg });
  assert.deepEqual(both.missingStarts, [], '两边都没有的起点不应记为缺失');
  assert.equal(both.historyReady, true);

  // 反向保护：旧来源有而候选没有，仍然必须阻塞，否则换源会真的丢掉该档位。
  const onlyCandidateMissing = gmgnReadiness({ candidate: frames(holed), previous: frames(bars), listedAt: null, now: T, cfg });
  assert.deepEqual(onlyCandidateMissing.missingStarts, ['r672'], '候选独缺时必须阻塞');
  assert.equal(onlyCandidateMissing.historyReady, false);
});
