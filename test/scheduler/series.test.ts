import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { GeckoTerminalError } from '../../src/api/geckoterminal.js';
import { loadStrategy } from '../../src/config/strategy.js';
import { HOUR_MS, INTERVAL_MS } from '../../src/market.js';
import { createNotifier } from '../../src/notify/telegram.js';
import { createScheduler } from '../../src/scheduler/main.js';
import { createQuotaGuard } from '../../src/scheduler/quota.js';
import { createCandleStore } from '../../src/store/candles.js';
import { openDatabase } from '../../src/store/db.js';
import { createMomentStore } from '../../src/store/moments.js';
import { createRuntimeStore } from '../../src/store/runtime.js';
import { createSeriesStore, MARKET_SERIES_FORMAT_VERSION, type MarketSeriesIdentity } from '../../src/store/series.js';
import { readRoundInputs } from '../../src/store/snapshot.js';
import type { Candle, DexSnapshot, Range } from '../../src/types.js';
import { boardPoolItem, candle, SAMPLE_STRATEGY } from '../helpers.js';

const now = 100 * INTERVAL_MS['1d'];
const ca = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const poolA = '0x1111111111111111111111111111111111111111';
const poolB = '0x2222222222222222222222222222222222222222';

function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  const state = { now, pair: poolA as string | null, network: 'ethereum' as string | null,
    boardChain: 'ethereum' as string | null, listedAt: now - 60 * INTERVAL_MS['1d'],
    mode: 'ok' as 'ok' | 'error' | 'empty' | 'gap' | 'invalid' | 'future', historyBars: 800, erwaCalls: 0 };
  const geckoCalls: { network: string; pool: string; limit: number; targetCa: string | undefined }[] = [];
  const quota = createQuotaGuard(db, cfg, () => state.now);
  const client = {
    async getTokenUsage() { quota.onCall(); return { usedToday: 0, remainingToday: 10_500, dailyLimit: 10_500 }; },
    async getBoardSummary() { quota.onCall(); return [boardPoolItem(ca.toUpperCase(), { chain: state.boardChain })]; },
    async getDexScreener(): Promise<DexSnapshot> {
      return { pairAddress: state.pair, chainId: state.network, priceUsd: 1, marketCap: 1_000_000, liquidityUsd: 100_000,
        priceChange: { m5: 0, h1: 0, h6: 0, h24: 999 }, pairCreatedAt: state.listedAt };
    },
    async getKline(_ca: string, _range: Range) {
      state.erwaCalls++;
      return { interval: '15m' as const, status: 'ok', candles: [candle(0, 1_000_000)] };
    },
  };
  const source = {
    async getCandles15m(network: string, pool: string, limit = 1000, targetCa?: string): Promise<Candle[]> {
      geckoCalls.push({ network, pool, limit, targetCa });
      if (state.mode === 'error') throw new GeckoTerminalError('GECKO_HTTP', '测试上游失败', 404);
      if (state.mode === 'empty') return [];
      const bars = Array.from({ length: state.historyBars }, (_, index) => candle(state.now - (state.historyBars - index) * INTERVAL_MS['15m'], 100 + index / 100));
      if (state.mode === 'gap') bars.splice(10, 1);
      if (state.mode === 'future') bars.push(candle(state.now, 9999), candle(state.now + INTERVAL_MS['15m'], 9999));
      if (state.mode === 'invalid') bars[bars.length - 1] = candle(state.now - INTERVAL_MS['15m'], NaN);
      return bars;
    },
  };
  const notifier = createNotifier({ db, cfg, dryRun: true, publicSite: 'https://example.test',
    send: async () => assert.fail('本地测试不得推送'), log: () => {} });
  const scheduler = createScheduler({ db, cfg, client, quota, notifier, klineSource: source, clock: () => state.now, log: () => {} });
  const round = () => createRuntimeStore(db).getRound()!;
  return { db, cfg, state, geckoCalls, scheduler, round, series: createSeriesStore(db) };
}

test('Gecko两轮固定首次成功交易对，Dex主池改变不换池；传入规范链与目标CA', async (t) => {
  const f = fixture(t);
  const first = await f.scheduler.runOnce(f.state.now);
  assert.equal(first!.failures, 0);
  const active = f.series.getActive('eth', ca)!;
  assert.ok(active);
  assert.equal(active.poolAddress, poolA);
  assert.equal(active.source, 'geckoterminal');
  assert.equal(f.round().members[0]!.seriesId, active.id);
  assert.deepEqual(f.geckoCalls[0], { network: 'eth', pool: poolA, limit: f.cfg.kline.bars15m, targetCa: ca });
  f.state.pair = poolB;
  f.state.now += HOUR_MS / 2;
  const second = await f.scheduler.runOnce(f.state.now);
  assert.equal(second!.failures, 0);
  assert.equal(f.geckoCalls[1]!.pool, poolA);
  assert.equal(f.series.getActive('eth', ca)!.id, active.id);
  assert.equal(f.round().members[0]!.seriesId, active.id);
  assert.equal(f.state.erwaCalls, 0);
  assert.deepEqual(f.db.prepare('SELECT pool_address FROM market_series').all(), [{ pool_address: poolA }]);
});

test('首次失败不激活、不读legacy高点；后续成功才建立新序列并独立记录新高', async (t) => {
  const f = fixture(t);
  const legacy = createCandleStore(f.db);
  const legacyMoments = createMomentStore(f.db);
  const oldBars = [candle(now - INTERVAL_MS['15m'], 9999)];
  const oldMoments = [{ moment: 1 as const, barTime: now - 10 * HOUR_MS, price: 9999 }];
  legacy.upsertCandles(ca, '15m', oldBars);
  legacyMoments.upsertMoments(ca, oldMoments, now);
  f.state.mode = 'error';
  const failure = await f.scheduler.runOnce(f.state.now);
  assert.ok(failure!.failures > 0);
  assert.equal(f.series.getActive('eth', ca), null);
  assert.equal(f.round().members[0]!.seriesId, null);
  assert.equal(f.round().members[0]!.klineStatus, 'error');
  assert.equal(failure!.results[0]!.result.reasons.a3, false);
  assert.deepEqual(failure!.results[0]!.result.newMoments, []);
  assert.equal(f.state.erwaCalls, 0);
  f.state.mode = 'ok';
  f.state.pair = poolB;
  f.state.now += HOUR_MS / 2;
  const recovered = await f.scheduler.runOnce(f.state.now);
  const active = f.series.getActive('eth', ca)!;
  assert.equal(active.poolAddress, poolB);
  assert.equal(recovered!.failures, 0);
  const newMoments = f.series.getMoments(active.id);
  assert.ok(newMoments.some((item) => item.moment === 1));
  assert.ok(newMoments.every((item) => item.price < 200));
  assert.deepEqual(legacy.getCandles(ca, '15m'), oldBars);
  assert.deepEqual(legacyMoments.getMoments(ca), oldMoments);
});

test('已有活动序列请求失败仍固定原池，不改写K线、不回退二娃', async (t) => {
  const f = fixture(t);
  await f.scheduler.runOnce(f.state.now);
  const active = f.series.getActive('eth', ca)!;
  const before = f.series.getCandles(active.id, '15m');
  f.state.now += HOUR_MS / 2;
  f.state.mode = 'error';
  f.state.pair = poolB;
  const failed = await f.scheduler.runOnce(f.state.now);
  assert.equal(f.geckoCalls[1]!.pool, poolA);
  assert.equal(f.series.getActive('eth', ca)!.id, active.id);
  assert.equal(f.round().members[0]!.seriesId, active.id);
  assert.equal(f.round().members[0]!.klineStatus, 'error');
  assert.deepEqual(f.series.getCandles(active.id, '15m'), before);
  assert.deepEqual(failed!.results[0]!.result.newMoments, []);
  assert.deepEqual(failed!.results[0]!.result.tags, []);
  assert.equal(f.state.erwaCalls, 0);
});

test('Gecko缺少交易对或空响应不调用二娃，不激活来源不明的数据', async (t) => {
  const f = fixture(t);
  f.state.pair = null;
  await f.scheduler.runOnce(f.state.now);
  assert.equal(f.geckoCalls.length, 0);
  assert.equal(f.state.erwaCalls, 0);
  assert.equal(f.round().members[0]!.seriesId, null);
  assert.equal(f.series.getActive('eth', ca), null);
  f.state.pair = poolA;
  f.state.mode = 'empty';
  f.state.now += HOUR_MS / 2;
  await f.scheduler.runOnce(f.state.now);
  assert.equal(f.geckoCalls.length, 1);
  assert.equal(f.state.erwaCalls, 0);
  assert.equal(f.round().members[0]!.seriesId, null);
  assert.equal(f.round().members[0]!.klineStatus, 'error');
  assert.equal(f.series.getActive('eth', ca), null);
});

test('新序列15m连续数据完整合成30m/1h/4h，缺失区间不自行补造', async (t) => {
  const complete = fixture(t);
  await complete.scheduler.runOnce(complete.state.now);
  const active = complete.series.getActive('eth', ca)!;
  assert.equal(complete.series.getCandles(active.id, '15m').length, 800);
  assert.equal(complete.series.getCandles(active.id, '1h').length, 200);
  assert.equal(complete.series.getCandles(active.id, '4h').length, 50);
  assert.equal(readRoundInputs(complete.db, complete.cfg, now, complete.round().members)[0]!.candles30m.length, 400);
  assert.equal(complete.series.getCandles(active.id, '1h', 1)[0]!.volume, 400);
  assert.equal(complete.series.getCandles(active.id, '4h', 1)[0]!.volume, 1600);
  assert.deepEqual(createCandleStore(complete.db).getCandles(ca, '15m'), []);
  const gap = fixture(t);
  gap.state.mode = 'gap';
  await gap.scheduler.runOnce(gap.state.now);
  const gapSeries = gap.series.getActive('eth', ca)!;
  assert.equal(gap.series.getCandles(gapSeries.id, '15m').length, 799);
  assert.equal(gap.series.getCandles(gapSeries.id, '1h').length, 199);
  assert.equal(gap.series.getCandles(gapSeries.id, '4h').length, 49);
  assert.equal(readRoundInputs(gap.db, gap.cfg, now, gap.round().members)[0]!.candles30m.length, 399);
});

test('写入失败时新序列与各周期原子回滚，不提前激活', async (t) => {
  const f = fixture(t);
  f.state.mode = 'invalid';
  const report = await f.scheduler.runOnce(f.state.now);
  assert.ok(report!.failures > 0);
  assert.equal(f.series.getActive('eth', ca), null);
  assert.equal(f.round().members[0]!.seriesId, null);
  assert.deepEqual(f.db.prepare('SELECT * FROM series_candles').all(), []);
  assert.deepEqual(f.db.prepare('SELECT * FROM series_moments').all(), []);
});


test('本轮基准尚未收盘K线不入库，之后采集失败也不能冒充新的共同收盘价', async (t) => {
  const f = fixture(t);
  f.state.mode = 'future';
  await f.scheduler.runOnce(f.state.now);
  const active = f.series.getActive('eth', ca)!;
  const bars = f.series.getCandles(active.id, '15m');
  assert.equal(bars.length, 800);
  assert.equal(bars[0]!.openTime, now - INTERVAL_MS['15m']);
  assert.ok(f.series.getMoments(active.id).every((item) => item.price < 200));
  f.state.now += HOUR_MS / 2;
  f.state.mode = 'error';
  await f.scheduler.runOnce(f.state.now);
  assert.equal(f.round().coverage.r16.available, 0);
  assert.equal(f.round().coverage.r16.missingCurrent, 1);
  assert.equal(f.series.getCandles(active.id, '15m')[0]!.openTime, now - INTERVAL_MS['15m']);
  assert.deepEqual(f.round().members[0]!.result!.tags, []);
});

test('不兼容活动来源保留数据库记录，但不采集、不进入RPS或规则读取', async (t) => {
  const variations: Partial<Extract<MarketSeriesIdentity, { source: 'geckoterminal' | 'erwa' }>>[] = [{ source: 'erwa' }, { formatVersion: MARKET_SERIES_FORMAT_VERSION + 1 }];
  for (const changed of variations) {
    const f = fixture(t);
    const incompatible = f.series.ensureSeries({ source: 'geckoterminal', network: 'eth', ca,
      poolAddress: poolA, currency: 'usd', formatVersion: MARKET_SERIES_FORMAT_VERSION, ...changed }, now);
    f.series.upsertCandles(incompatible.id, '15m', Array.from({ length: 800 }, (_, index) =>
      candle(now - (800 - index) * INTERVAL_MS['15m'], 100 + index)));
    f.series.upsertMoments(incompatible.id, [{ moment: 1, barTime: now - HOUR_MS, price: 1000 }], now);
    f.series.activateSeries(incompatible.id, now);
    const report = await f.scheduler.runOnce(f.state.now);
    assert.ok(report!.failures > 0);
    assert.equal(f.geckoCalls.length, 0);
    assert.equal(f.state.erwaCalls, 0);
    assert.equal(f.round().members[0]!.seriesId, null);
    assert.equal(f.round().coverage.r16.available, 0);
    assert.equal(f.round().members[0]!.result!.reasons.a3, false);
    assert.deepEqual(readRoundInputs(f.db, f.cfg, now, f.round().members)[0]!.candles15m, []);
    assert.equal(f.series.getActive('eth', ca)!.id, incompatible.id);
    assert.equal(f.series.getCandles(incompatible.id, '15m').length, 800);
  }
});

test('同CA跨链切换分别缓存上市时间，不继承另一链或无链legacy日期', async (t) => {
  const f = fixture(t);
  const runtime = createRuntimeStore(f.db, () => f.state.now);
  const oldLegacy = now - 90 * INTERVAL_MS['1d'];
  runtime.cacheListing(ca, oldLegacy);
  const ethListing = f.state.listedAt;
  await f.scheduler.runOnce(f.state.now);
  assert.equal(f.round().members[0]!.pool.listedAt, ethListing);
  assert.equal(runtime.getListing(ca, 'eth'), ethListing);
  assert.equal(runtime.getListing(ca), oldLegacy);
  f.state.now += HOUR_MS / 2;
  f.state.boardChain = 'base';
  f.state.network = 'base';
  f.state.pair = poolB;
  f.state.listedAt = f.state.now - HOUR_MS;
  // 新链仅有一小时历史；不能带入另一链已有的200小时K线证明RPS适龄。
  f.state.historyBars = 4;
  const switched = await f.scheduler.runOnce(f.state.now);
  assert.equal(f.round().members[0]!.pool.listedAt, f.state.listedAt);
  assert.equal(runtime.getListing(ca, 'base'), f.state.listedAt);
  assert.equal(runtime.getListing(ca, 'eth'), ethListing);
  assert.equal(switched!.results[0]!.result.reasons.a1, false);
  assert.equal(f.round().coverage.r16.eligible, 0);
  assert.equal(f.series.getActive('eth', ca)!.poolAddress, poolA);
  assert.equal(f.series.getActive('base', ca)!.poolAddress, poolB);
});

test('Dex链与观察池不匹配时不污染上市缓存，之后匹配响应才能写入', async (t) => {
  const f = fixture(t);
  const runtime = createRuntimeStore(f.db, () => f.state.now);
  f.state.network = 'base';
  await f.scheduler.runOnce(f.state.now);
  assert.equal(runtime.getListing(ca, 'eth'), null);
  assert.equal(runtime.getListing(ca, 'base'), null);
  assert.equal(runtime.getListing(ca), null);
  assert.equal(f.round().members[0]!.pool.listedAt, null);
  assert.equal(f.round().members[0]!.result!.reasons.a1, false);
  assert.equal(f.geckoCalls.length, 0);
  f.state.now += HOUR_MS / 2;
  f.state.network = 'ethereum';
  f.state.listedAt = f.state.now - HOUR_MS;
  const recovered = await f.scheduler.runOnce(f.state.now);
  assert.equal(runtime.getListing(ca, 'eth'), f.state.listedAt);
  assert.equal(runtime.getListing(ca, 'base'), null);
  assert.equal(f.round().members[0]!.pool.listedAt, f.state.listedAt);
  assert.equal(recovered!.results[0]!.result.reasons.a1, false);
});
