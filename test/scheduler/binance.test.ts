import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { BinanceWeb3Error, resolveBinanceChain, type BinanceWeb3CandleResult } from '../../src/api/binance-web3.js';
import type { RateLimitStore } from '../../src/api/erwa.js';
import { loadStrategy } from '../../src/config/strategy.js';
import { INTERVAL_MS } from '../../src/market.js';
import { createBinanceCollector, type BinanceCollectionStatus } from '../../src/scheduler/binance.js';
import { openDatabase } from '../../src/store/db.js';
import { createPoolStore } from '../../src/store/pool.js';
import { createRuntimeStore, initialRound, pendingMember } from '../../src/store/runtime.js';
import { createSeriesStore } from '../../src/store/series.js';
import { candle, poolItem, SAMPLE_STRATEGY } from '../helpers.js';

const STEP = INTERVAL_MS['15m'];
const T = 100 * INTERVAL_MS['1d'];
const ca = (index: number) => '0x' + index.toString(16).padStart(40, '0');

interface Request { network: string; ca: string; from: number; to: number; at: number }
interface Spec { ca: string; chain?: string; active?: 'binance' | 'geckoterminal' }
interface Persisted {
  requests: number; recentRequests: number; historyRequests: number;
  assets: Array<{ ca: string; targetFrom: number | null; historyTo: number | null; historyComplete: boolean;
    recentDueAt: number; recentOrder: number; historyOrder: number;
    lastAttempt: { kind: string; from: number; to: number; at: number } | null }>;
}

/** 默认应答：窗口内每根都给，且都已收盘。 */
function result(request: Request): BinanceWeb3CandleResult {
  const count = Math.max(0, Math.min(300, (request.to - request.from) / STEP));
  const times = Array.from({ length: count }, (_, i) => request.to - (count - i) * STEP);
  return {
    source: { provider: 'binance', scope: 'token', chain: request.network, ca: request.ca, currency: 'usd', pool: null },
    candles: times.map((time) => candle(time, 1 + (time / STEP % 100) / 100)),
    exhausted: false,
  };
}

function fixture(t: TestContext, specs: Spec[] = [{ ca: ca(1) }]) {
  const db = openDatabase(':memory:');
  t.after(() => { if (db.open) db.close(); });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('采集器测试不得调用真实 HTTP'));

  const cfg = loadStrategy(SAMPLE_STRATEGY);
  cfg.kline.bars15m = 300;
  cfg.kline.binance = { enabled: true, requestsPerMinute: 120, refreshMinutes: 1, historyDays: 8,
    chains: ['robinhood', 'bsc', 'solana', 'base', 'ethereum', 'avalanche'] };

  let now = T;
  const clock = () => now;
  const runtime = createRuntimeStore(db, clock);
  const series = createSeriesStore(db);
  const pool = createPoolStore(db);
  const calls: Request[] = [];
  const logs: string[] = [];
  let rateLimitStore: RateLimitStore | null = null;
  let handler: (request: Request) => Promise<BinanceWeb3CandleResult> = async (request) => result(request);

  const client = {
    setRateLimitStore(store: RateLimitStore) { rateLimitStore = store; },
    async getCandles15m(network: string, address: string, range: { from: number; to: number }): Promise<BinanceWeb3CandleResult> {
      const request = { network, ca: address, ...range, at: now };
      calls.push(request);
      return handler(request);
    },
  };

  function publish(items: Spec[] = specs) {
    pool.upsertPool(items.map((item) => poolItem(item.ca, { chain: item.chain ?? 'ethereum' })), now);
    const round = initialRound(cfg, now);
    round.boardComplete = true;
    round.sourceCount = items.length;
    round.observedAt = now;
    round.members = items.map((item) => ({ ...pendingMember(pool.getPoolItem(item.ca)!, 1), seriesId: null }));
    runtime.saveObservationRound(round);
  }

  for (const item of specs) {
    if (!item.active) continue;
    const network = item.chain === 'solana' ? 'solana' : item.chain === 'ethereum' || !item.chain ? 'eth' : item.chain;
    const identity = series.ensureSeries(item.active === 'binance'
      ? { source: 'binance', scope: 'token', network, ca: item.ca, currency: 'usd', poolAddress: null, formatVersion: 1 }
      : { source: 'geckoterminal', network, ca: item.ca, currency: 'usd', poolAddress: 'pool-' + item.ca, formatVersion: 1 }, now);
    series.upsertCandles(identity.id, '15m', [candle(T - STEP, 999)]);
    series.activateSeries(identity.id, now);
  }
  publish();

  const make = () => createBinanceCollector({ db, cfg, client, clock, log: (message) => logs.push(message) });
  let collector = make();
  const read = <V>(key: string): V => JSON.parse((db.prepare('SELECT payload FROM runtime_state WHERE key=?')
    .get(key) as { payload: string }).payload) as V;

  return {
    db, cfg, series, runtime, calls, logs, clock, publish, make,
    state: () => read<Persisted>('binance_state'),
    status: () => read<BinanceCollectionStatus>('binance_status'),
    setNow: (value: number) => { now = value; },
    setHandler: (value: typeof handler) => { handler = value; },
    cooldown: () => rateLimitStore!,
    collector: () => collector,
    restart() { collector.stop(); collector = make(); },
    async step() {
      const report = await collector.collectOnce(now);
      if (report) now = report.nextAt;
      return report;
    },
  };
}

test('为观察成员建立 binance 候选序列并写入 15m，不激活也不改动既有 Gecko 活跃序列', async (t) => {
  const f = fixture(t, [{ ca: ca(1), active: 'geckoterminal' }]);

  const report = await f.step();

  assert.equal(report?.attempted, true, '应发出一次采集请求');
  assert.equal(f.calls.length, 1, '单次 collectOnce 只发一个请求');
  assert.equal(f.calls[0]!.network, 'eth');
  assert.equal(f.calls[0]!.ca, ca(1));

  const candidate = f.series.getTokenSeries('eth', ca(1), 'binance');
  assert.ok(candidate, '应创建 binance token 候选序列');
  assert.equal(candidate.scope, 'token');
  assert.equal(candidate.poolAddress, null);
  assert.equal(candidate.active, false, '候选序列不得自动激活');
  assert.ok(f.series.getCandles(candidate.id, '15m').length > 0, '应把 15m K 线写进候选序列');

  const active = f.series.getActive('eth', ca(1));
  assert.equal(active?.source, 'geckoterminal', '既有活跃来源不得被采集器改动');
});

test('跳过 binance 不支持的链，不产生任何请求', async (t) => {
  const f = fixture(t, [{ ca: ca(2), chain: 'arc' }]);

  const report = await f.step();

  assert.equal(report?.attempted, false, 'arc 不在 binance 支持范围内，不应发请求');
  assert.equal(f.calls.length, 0);
  assert.equal(resolveBinanceChain('arc'), null, '前提：arc 确实不被支持');
  assert.equal(f.series.getTokenSeries('arc', ca(2), 'binance'), null, '不支持的链不得创建候选序列');
});

test('多成员公平轮转：连续三次采集分别命中三个成员，不重复打同一个', async (t) => {
  const f = fixture(t, [{ ca: ca(1) }, { ca: ca(2) }, { ca: ca(3) }]);

  await f.step();
  await f.step();
  await f.step();

  assert.equal(f.calls.length, 3);
  assert.deepEqual(new Set(f.calls.map((call) => call.ca)).size, 3, '三次请求应覆盖三个不同成员');
});

test('刷新周期未到不再打近期端点，预算让给历史回补', async (t) => {
  const f = fixture(t, [{ ca: ca(1) }]);

  const first = await f.step();
  await f.collector().collectOnce(first!.nextAt);

  assert.equal(f.state().recentRequests, 1, 'refreshMinutes 未到不得重复请求近期端点');
  assert.equal(f.state().historyRequests, 1, '空出的预算应用于历史回补');
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1]!.to <= f.calls[0]!.from + STEP, '第二次请求必须是更早的历史窗口');
});

test('近期窗口之后按页回补历史，直到计划起点才停止，且从不越过起点', async (t) => {
  const f = fixture(t, [{ ca: ca(1) }]);

  await f.step();
  for (let i = 0; i < 12 && !f.state().assets[0]!.historyComplete; i++) await f.step();

  const asset = f.state().assets[0]!;
  assert.equal(asset.historyComplete, true, '应在有限次数内完成回补');
  assert.equal(asset.historyTo, asset.targetFrom);
  for (const call of f.calls) {
    assert.ok(call.from >= asset.targetFrom!, '任何请求都不得早于计划起点');
  }
});

test('上游已给尽最早数据时立刻结束回补', async (t) => {
  const f = fixture(t, [{ ca: ca(1) }]);
  await f.step();
  f.setHandler(async (request) => ({ ...result(request), candles: [], exhausted: true }));

  await f.step();

  assert.equal(f.state().assets[0]!.historyComplete, true, 'exhausted 应终止回补');
});

test('限流进入持久冷却，冷却期内不再发请求', async (t) => {
  const f = fixture(t, [{ ca: ca(1) }]);
  f.setHandler(async () => { throw new BinanceWeb3Error('BINANCE_RATE_LIMIT', '限流', 429, T + 600_000); });

  const limited = await f.step();

  assert.equal(limited?.attempted, true, '第一次请求确实打出去了');
  assert.equal(f.status().status, 'cooldown');
  assert.equal(f.cooldown().getUntil(), T + 600_000);

  const during = await f.collector().collectOnce(T + 60_000);
  assert.equal(during?.attempted, false, '冷却期内不得再发请求');
  assert.equal(f.calls.length, 1);
});

test('鉴权失败后停摆并记录，不再消耗预算', async (t) => {
  const f = fixture(t, [{ ca: ca(1) }]);
  f.setHandler(async () => { throw new BinanceWeb3Error('BINANCE_AUTH', '鉴权失败', 401); });

  await f.step();
  const after = await f.step();

  assert.equal(f.status().status, 'auth_error');
  assert.equal(f.status().lastErrorCode, 'BINANCE_AUTH');
  assert.equal(after?.attempted, false, '鉴权失败后不应继续请求');
  assert.equal(f.calls.length, 1);
});

test('响应身份与请求不符时拒绝写入候选序列', async (t) => {
  const f = fixture(t, [{ ca: ca(1) }]);
  f.setHandler(async (request) => ({ ...result(request),
    source: { provider: 'binance', scope: 'token', chain: 'bsc', ca: request.ca, currency: 'usd', pool: null } }));

  await f.step();

  const candidate = f.series.getTokenSeries('eth', ca(1), 'binance');
  assert.ok(candidate, '候选身份已创建');
  assert.equal(f.series.getCandles(candidate.id, '15m').length, 0, '链不符的响应不得入库');
  assert.equal(f.status().lastErrorCode, 'BINANCE_IDENTITY');
});

test('停用时不发请求也不创建候选序列', async (t) => {
  const f = fixture(t, [{ ca: ca(1) }]);
  f.cfg.kline.binance.enabled = false;
  f.restart();

  const report = await f.step();

  assert.equal(report?.attempted, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.status().status, 'disabled');
});

test('近期请求持续到期时历史回补仍能拿到份额，不被饿死', async (t) => {
  // 刷新需求高于吞吐：3 个成员、每分钟仅 1 次请求、刷新周期 1 分钟，
  // 轮一遍要 3 分钟而每个成员 1 分钟就再次到期，近期队列永远非空。
  const f = fixture(t, [{ ca: ca(1) }, { ca: ca(2) }, { ca: ca(3) }]);
  f.cfg.kline.binance.requestsPerMinute = 1;
  f.cfg.kline.binance.refreshMinutes = 1;
  // 改配置会改变 strategyKey，必须按新配置重新发布名单，否则观察轮次会被拒收。
  f.publish();
  f.restart();

  for (let i = 0; i < 20; i++) await f.step();

  const state = f.state();
  assert.ok(state.recentRequests > 0, '近期请求应正常进行');
  assert.ok(state.historyRequests > 0,
    `历史回补被近期请求饿死：20 次采集里历史请求 ${state.historyRequests} 次`);
});
