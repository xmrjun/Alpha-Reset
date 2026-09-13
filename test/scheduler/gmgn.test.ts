import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { GmgnError, resolveGmgnChain, type GmgnCandleResult } from '../../src/api/gmgn.js';
import type { RateLimitStore } from '../../src/api/erwa.js';
import { loadStrategy } from '../../src/config/strategy.js';
import { INTERVAL_MS } from '../../src/market.js';
import { createGmgnCollector, type GmgnCollectionStatus } from '../../src/scheduler/gmgn.js';
import { openDatabase } from '../../src/store/db.js';
import { createCandleStore } from '../../src/store/candles.js';
import { createPoolStore } from '../../src/store/pool.js';
import { createRuntimeStore, initialRound, pendingMember, strategyKey } from '../../src/store/runtime.js';
import { createSeriesStore } from '../../src/store/series.js';
import { candle, poolItem, SAMPLE_STRATEGY } from '../helpers.js';

const STEP = INTERVAL_MS['15m'];
const T = 100 * INTERVAL_MS['1d'];
const ca = (index: number) => '0x' + index.toString(16).padStart(40, '0');
interface Request { chain: string; ca: string; from: number; to: number; at: number }
interface Spec { ca: string; chain?: string; active?: 'gmgn' | 'geckoterminal' }
interface Persisted {
  requests: number; recentRequests: number; historyRequests: number; recentBurst: number;
  assets: Array<{ ca: string; admitted: boolean; targetFrom: number | null; historyTo: number | null;
    historyComplete: boolean; recentDueAt: number; historyOrder: number; recentOrder: number;
    lastAttempt: { kind: string; from: number; to: number; at: number } | null }>;
}
function result(request: Request, times?: number[]): GmgnCandleResult {
  // 实测近期100区间最多99根已收盘；历史96区间不触及100条上限。
  const all = times ?? Array.from({ length: Math.min(99, (request.to - request.from) / STEP) },
    (_, i) => request.to - (Math.min(99, (request.to - request.from) / STEP) - i) * STEP);
  return { source: { provider: 'gmgn', scope: 'token', chain: resolveGmgnChain(request.chain)!, ca: request.ca, currency: 'usd', pool: null },
    candles: all.map((time) => candle(time, 1 + (time / STEP % 100) / 100)) };
}
function fixture(t: TestContext, specs: Spec[] = [{ ca: ca(1) }], filename = ':memory:') {
  const db = openDatabase(filename);
  t.after(() => { if (db.open) db.close(); });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('采集器测试不得调用真实 HTTP'));
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  cfg.kline.bars15m = 300;
  cfg.kline.gmgn = { enabled: true, requestsPerMinute: 30, refreshMinutes: 10, warmupAssets: 1,
    chains: ['sol', 'bsc', 'base', 'eth', 'robinhood'] };
  let now = T;
  const clock = () => now;
  const runtime = createRuntimeStore(db, clock);
  const series = createSeriesStore(db);
  const pool = createPoolStore(db);
  const calls: Request[] = [];
  const logs: string[] = [];
  let rateLimitStore: RateLimitStore | null = null;
  let handler: (request: Request) => Promise<GmgnCandleResult> = async (request) => result(request);
  const client = {
    setRateLimitStore(store: RateLimitStore) { rateLimitStore = store; },
    async getCandles15m(chain: string, address: string, range: { from: number; to: number }): Promise<GmgnCandleResult> {
      const request = { chain, ca: address, ...range, at: now }; calls.push(request);
      return handler(request);
    },
  };
  function publish(items: Spec[] = specs, changedKey = false) {
    pool.upsertPool(items.map((item) => poolItem(item.ca, { chain: item.chain ?? 'ethereum' })), now);
    const round = initialRound(cfg, now);
    round.boardComplete = true; round.sourceCount = items.length; round.observedAt = now;
    round.members = items.map((item) => ({ ...pendingMember(pool.getPoolItem(item.ca)!, 1), seriesId: null }));
    if (changedKey) round.strategyKey = 'different-configuration';
    runtime.saveObservationRound(round);
  }
  for (const item of specs) {
    if (!item.active) continue;
    const network = item.chain === 'solana' ? 'solana' : item.chain === 'ethereum' || !item.chain ? 'eth' : item.chain;
    const identity = series.ensureSeries(item.active === 'gmgn'
      ? { source: 'gmgn', scope: 'token', network, ca: item.ca, currency: 'usd', poolAddress: null, formatVersion: 1 }
      : { source: 'geckoterminal', network, ca: item.ca, currency: 'usd', poolAddress: 'pool-' + item.ca, formatVersion: 1 }, now);
    series.upsertCandles(identity.id, '15m', [candle(T - STEP, 999)]);
    series.activateSeries(identity.id, now);
  }
  publish();
  const make = () => createGmgnCollector({ db, cfg, client, clock, log: (message) => logs.push(message) });
  let collector = make();
  const read = <V>(key: string): V => JSON.parse((db.prepare('SELECT payload FROM runtime_state WHERE key=?').get(key) as { payload: string }).payload) as V;
  return { db, cfg, series, runtime, client, calls, logs, clock, publish, make,
    state: () => read<Persisted>('gmgn_state'), status: () => read<GmgnCollectionStatus>('gmgn_status'),
    setNow: (value: number) => { now = value; }, setHandler: (value: typeof handler) => { handler = value; },
    cooldown: () => rateLimitStore!, collector: () => collector,
    restart() { collector.stop(); collector = make(); },
    async step() {
      const report = await collector.collectOnce(now);
      if (report) now = report.nextAt;
      return report;
    },
  };
}

test('单次只有一个近期请求，创建独立GMGN候选但不激活或污染Gecko/legacy/评分', async (t) => {
  const f = fixture(t, [{ ca: ca(1), active: 'geckoterminal' }]);
  const gecko = f.series.getActive('eth', ca(1))!;
  createCandleStore(f.db).upsertCandles(ca(1), '15m', [candle(T - STEP, 777)]);
  const beforePool = f.runtime.getObservationRound();
  const report = await f.step();
  assert.equal(report!.attempted, true); assert.equal(report!.changed, true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { chain: 'eth', ca: ca(1), from: T - 100 * STEP, to: T, at: T });
  const candidate = f.series.getTokenSeries('eth', ca(1))!;
  assert.equal(candidate.active, false); assert.equal(candidate.scope, 'token'); assert.equal(candidate.poolAddress, null);
  assert.equal(f.series.getActive('eth', ca(1))!.id, gecko.id);
  assert.deepEqual(f.series.getCandles(gecko.id, '15m'), [candle(T - STEP, 999)]);
  assert.deepEqual(createCandleStore(f.db).getCandles(ca(1), '15m'), [candle(T - STEP, 777)]);
  assert.deepEqual(f.runtime.getObservationRound(), beforePool);
  assert.equal(f.runtime.getRound(), null);
  assert.deepEqual(f.series.getMoments(candidate.id), []);
  assert.equal(f.status().recentRequests, 1); assert.equal(f.status().historyRequests, 0);
});

test('先采active和无active新CA，Gecko仅准入warmupAssets个，查询完成释放暖槽', async (t) => {
  const f = fixture(t, [{ ca: ca(1), active: 'geckoterminal' }, { ca: ca(2), active: 'geckoterminal' },
    { ca: ca(3) }, { ca: ca(4), active: 'gmgn' }]);
  await f.step(); await f.step(); await f.step();
  assert.deepEqual(f.calls.map((request) => request.ca), [ca(3), ca(4), ca(1)]);
  assert.equal(f.series.getTokenSeries('eth', ca(2)), null, '尚未入暖槽不得抢先创建/采集');
  assert.equal(f.status().backfillPending, 3);
  for (let count = 0; count < 30 && !f.calls.some((request) => request.ca === ca(2)); count++) await f.step();
  assert.ok(f.state().assets.find((asset) => asset.ca === ca(1))!.historyComplete);
  assert.ok(f.calls.some((request) => request.ca === ca(2)), '完成范围查询后下一个候选进入暖槽');
  assert.equal(f.series.getActive('eth', ca(1))!.source, 'geckoterminal');
});

test('历史96区间分段、相邻重叠1根，累计合成完整1h/4h且无重复', async (t) => {
  const f = fixture(t);
  for (let count = 0; count < 20; count++) {
    await f.step();
    if (f.state().assets[0]!.historyComplete) break;
  }
  const requests = f.calls;
  assert.equal(requests.length, 4);
  assert.equal(requests[1]!.to, T - 98 * STEP, '近期最早返回T-99根，加1根用于重叠');
  assert.equal(requests[1]!.to - requests[1]!.from, 96 * STEP);
  assert.equal(requests[2]!.to, requests[1]!.from + STEP);
  assert.equal(requests.at(-1)!.from, T - 300 * STEP);
  const selected = f.series.getTokenSeries('eth', ca(1))!;
  const bars = f.series.getCandles(selected.id, '15m');
  assert.equal(bars.length, 300);
  assert.equal(new Set(bars.map((bar) => bar.openTime)).size, 300);
  assert.equal(f.series.getCandles(selected.id, '1h').length, 75);
  assert.equal(f.series.getCandles(selected.id, '4h').length, 18);
  assert.equal(f.status().assetsWithHistory, 1);
  assert.equal(f.status().backfillPending, 0);
  assert.equal(f.status().requests, 4);
});

test('成功的空/稀疏页仍推进查询边界并释放暖槽，但不补价或冒称连续完整', async (t) => {
  const f = fixture(t, [{ ca: ca(1), active: 'geckoterminal' }, { ca: ca(2), active: 'geckoterminal' }]);
  f.setHandler(async (request) => result(request, request.to - request.from === 100 * STEP ? [request.to - STEP] : []));
  for (let count = 0; count < 20 && !f.calls.some((request) => request.ca === ca(2)); count++) await f.step();
  const first = f.state().assets.find((asset) => asset.ca === ca(1))!;
  assert.equal(first.historyComplete, true);
  assert.equal(first.historyTo, T - 300 * STEP);
  const selected = f.series.getTokenSeries('eth', ca(1))!;
  assert.equal(f.series.getCandles(selected.id, '15m').length, 1);
  assert.equal(f.series.getCandles(selected.id, '1h').length, 0);
  assert.ok(f.calls.some((request) => request.ca === ca(2)));
  assert.equal(f.series.getActive('eth', ca(1))!.source, 'geckoterminal');
  assert.ok(f.status().assetsWithHistory >= 1, '该字段仅说明范围已查询，不代表K线齐全');
});

test('持久attempt在调用前存在，失败移到队尾，重启后另一个CA优先且游标不丢', async (t) => {
  const f = fixture(t, [{ ca: ca(1) }, { ca: ca(2) }]);
  f.setHandler(async (request) => {
    const asset = f.state().assets.find((item) => item.ca === request.ca)!;
    assert.deepEqual(asset.lastAttempt, { kind: 'recent', from: request.from, to: request.to, at: request.at });
    throw new GmgnError('GMGN_NETWORK', '网络错误');
  });
  await f.step();
  assert.equal(f.calls.length, 1);
  f.restart();
  f.setHandler(async (request) => result(request));
  await f.step();
  assert.equal(f.calls[1]!.ca, ca(2));
  const second = f.state().assets.find((asset) => asset.ca === ca(2))!;
  const cursor = second.historyTo;
  f.restart();
  await f.step();
  assert.equal(f.calls[2]!.ca, ca(2));
  assert.equal(f.calls[2]!.to, cursor);
  assert.equal(f.calls[2]!.to - f.calls[2]!.from, 96 * STEP);
});

test('历史失败不推进游标，其他资产先回补，轮转后重试原窗口', async (t) => {
  const f = fixture(t, [{ ca: ca(1) }, { ca: ca(2) }]);
  await f.step(); await f.step();
  const cursor = f.state().assets[0]!.historyTo;
  let failed: Request | null = null;
  f.setHandler(async (request) => {
    if (!failed) { failed = request; throw new GmgnError('GMGN_NETWORK', '失败'); }
    return result(request);
  });
  await f.step();
  assert.equal(f.state().assets[0]!.historyTo, cursor);
  f.restart(); await f.step();
  assert.equal(f.calls[3]!.ca, ca(2));
  f.setNow(T + 31000);
  for (let count = 0; count < 10 && f.calls.filter((request) => request.ca === ca(1)).length < 3; count++) await f.step();
  const retried = f.calls.filter((request) => request.ca === ca(1))[2]!;
  assert.equal(retried.from, (failed as unknown as Request).from);
  assert.equal(retried.to, (failed as unknown as Request).to);
});

test('新15m闭合后立即排近期，当前端点不会被10分钟刷新间隔拖后', async (t) => {
  const f = fixture(t);
  f.setNow(T + STEP - 60_000);
  await f.step();
  assert.equal(f.calls[0]!.to, T);
  f.setNow(T + STEP + 1000);
  await f.step();
  assert.equal(f.calls[1]!.to, T + STEP);
  assert.equal(f.calls[1]!.to - f.calls[1]!.from, 100 * STEP);
});

test('大量首次待采与持续due近期也给历史保留每4次1页，不永久饥饿', async (t) => {
  const f = fixture(t, Array.from({ length: 20 }, (_, i) => ({ ca: ca(i + 1) })));
  for (let i = 0; i < 5; i++) await f.step();
  assert.equal(f.calls[4]!.to - f.calls[4]!.from, 96 * STEP, '第5个任务让历史推进，即使还有首次待采成员');
  assert.equal(f.state().historyRequests, 1);
  f.setNow(T + STEP + 1000);
  for (let i = 0; i < 5; i++) await f.step();
  assert.equal(f.state().historyRequests, 2);
});

test('241个持续due active不会饿死warm近期，warm能在新边界刷新且primary保留多数份额', async (t) => {
  const warmCa = ca(999);
  const specs: Spec[] = [{ ca: warmCa, active: 'geckoterminal' },
    ...Array.from({ length: 241 }, (_, i): Spec => ({ ca: ca(i + 1), active: 'gmgn' }))];
  const f = fixture(t, specs);
  for (let i = 0; i < 7 && !f.calls.some((request) => request.ca === warmCa); i++) await f.step();
  assert.ok(f.calls.some((request) => request.ca === warmCa));
  const before = f.calls.length;
  f.setNow(T + STEP + 1000);
  for (let i = 0; i < 8 && !f.calls.slice(before).some((request) => request.ca === warmCa
    && request.to === T + STEP && request.to - request.from === 100 * STEP); i++) await f.step();
  assert.ok(f.calls.slice(before).some((request) => request.ca === warmCa && request.to === T + STEP
    && request.to - request.from === 100 * STEP), '下一15m端点不能一直被active抢走');
  const recent = f.calls.filter((request) => request.to - request.from === 100 * STEP);
  assert.ok(recent.filter((request) => request.ca !== warmCa).length >= 4 * recent.filter((request) => request.ca === warmCa).length);
});

test('每次读取最新完整同配置池，已移出CA停止采集，旧状态不覆盖新名单', async (t) => {
  const f = fixture(t, [{ ca: ca(1) }, { ca: ca(2) }]);
  await f.step();
  f.publish([{ ca: ca(2) }]);
  const before = f.runtime.getObservationRound();
  for (let i = 0; i < 5; i++) await f.step();
  assert.equal(f.calls.filter((request) => request.ca === ca(1)).length, 1);
  assert.deepEqual(f.runtime.getObservationRound(), before);
  f.publish([{ ca: ca(2) }], true);
  const calls = f.calls.length;
  const report = await f.step();
  assert.equal(report!.attempted, false); assert.equal(f.calls.length, calls);
  assert.ok(report!.nextAt > f.clock() - 60_001);
});

test('在途移出只保留attempt、不写返回数据；stop和重入不发额外请求', async (t) => {
  const f = fixture(t);
  let finish!: (value: GmgnCandleResult) => void;
  f.setHandler(() => new Promise((resolve) => { finish = resolve; }));
  const running = f.collector().collectOnce(T);
  assert.equal(await f.collector().collectOnce(T), null);
  f.publish([]);
  finish(result(f.calls[0]!));
  assert.equal((await running)!.changed, false);
  const candidate = f.series.getTokenSeries('eth', ca(1))!;
  assert.deepEqual(f.series.getCandles(candidate.id, '15m'), []);
  f.collector().stop();
  assert.equal(await f.collector().collectOnce(T + 10000), null);
  assert.equal(f.calls.length, 1);
});

test('429持久全源冷却跨重启恢复，Gecko与二娃冷却不变', async (t) => {
  const f = fixture(t, [{ ca: ca(1) }, { ca: ca(2) }]);
  f.db.prepare('INSERT INTO runtime_state VALUES (?,?,?)').run('gecko_cooldown', JSON.stringify({ until: T + 1000 }), T);
  f.db.prepare('INSERT INTO runtime_state VALUES (?,?,?)').run('api_cooldown', JSON.stringify({ until: T + 2000 }), T);
  f.setHandler(async () => { throw new GmgnError('GMGN_RATE_LIMIT', '冷却', 429, T + 120000); });
  const first = await f.collector().collectOnce(T);
  assert.equal(first!.attempted, true); assert.equal(first!.nextAt, T + 120000);
  assert.equal(f.status().status, 'cooldown'); assert.equal(f.cooldown().getUntil(), T + 120000);
  f.restart(); f.setNow(T + 10000);
  const blocked = await f.collector().collectOnce();
  assert.equal(blocked!.attempted, false); assert.equal(f.calls.length, 1);
  assert.equal(f.runtime.geckoRateLimitStore.getUntil(), T + 1000);
  assert.equal(f.runtime.rateLimitStore.getUntil(), T + 2000);
  f.setNow(T + 120000); f.setHandler(async (request) => result(request));
  await f.step();
  assert.equal(f.calls[1]!.ca, ca(2));
});

test('401/403持久暂停且普通重启不重试，清除独立auth状态后恢复', async (t) => {
  for (const status of [401, 403]) {
    const f = fixture(t);
    f.setHandler(async () => { throw new GmgnError('GMGN_HTTP', '固定说明', status); });
    await f.step(); f.restart();
    for (let i = 0; i < 3; i++) await f.step();
    assert.equal(f.calls.length, 1); assert.equal(f.status().status, 'auth_error');
    f.db.prepare("DELETE FROM runtime_state WHERE key='gmgn_auth_error'").run();
    f.setHandler(async (request) => result(request));
    await f.step();
    assert.equal(f.calls.length, 2);
  }
});

test('来源、链、CA或OHLC错误不能入库，固定错误状态不泄露原始文本', async (t) => {
  for (const kind of ['provider', 'chain', 'ca', 'pool', 'bar', 'conflict', 'error']) {
    const f = fixture(t);
    f.setHandler(async (request) => {
      if (kind === 'error') throw new Error('PRIVATE_RESPONSE_API_KEY');
      const response = result(request);
      if (kind === 'provider') (response.source as { provider: string }).provider = 'geckoterminal';
      if (kind === 'chain') response.source.chain = 'base';
      if (kind === 'ca') response.source.ca = ca(999);
      if (kind === 'pool') (response.source as { pool: string | null }).pool = 'pool-unknown';
      if (kind === 'bar') response.candles[0]!.volume = -1;
      if (kind === 'conflict') response.candles.push({ ...response.candles[0]!, close: response.candles[0]!.close + 1,
        high: response.candles[0]!.high + 1 });
      return response;
    });
    const report = await f.step();
    assert.equal(report!.changed, false);
    const candidate = f.series.getTokenSeries('eth', ca(1))!;
    assert.deepEqual(f.series.getCandles(candidate.id, '15m'), []);
    assert.equal(f.state().assets[0]!.historyTo, null);
    assert.ok(!JSON.stringify(f.status()).includes('PRIVATE_RESPONSE_API_KEY'));
    assert.ok(!f.logs.join('').includes('PRIVATE_RESPONSE_API_KEY'));
  }
});

test('按请求开始时间再过滤未收盘/越窗行，真实零量保留，缺失高周期不合成', async (t) => {
  const f = fixture(t);
  f.setHandler(async (request) => {
    f.setNow(T + STEP);
    const response = result(request, [T - 4 * STEP, T - 2 * STEP, T - STEP, T, T + STEP, request.from - STEP]);
    response.candles[0]!.volume = 0;
    return response;
  });
  await f.step();
  const id = f.series.getTokenSeries('eth', ca(1))!.id;
  assert.deepEqual(f.series.getCandles(id, '15m').map((bar) => bar.openTime), [T - STEP, T - 2 * STEP, T - 4 * STEP]);
  assert.equal(f.series.getCandles(id, '15m').at(-1)!.volume, 0);
  assert.deepEqual(f.series.getCandles(id, '1h'), []);
});

test('反复失败的warm候选暂让出槽位，不让永久错误堵住所有候选', async (t) => {
  const f = fixture(t, [{ ca: ca(1), active: 'geckoterminal' }, { ca: ca(2), active: 'geckoterminal' }]);
  f.setHandler(async (request) => {
    if (request.ca === ca(1)) throw new GmgnError('GMGN_HTTP', '固定失败', 400);
    return result(request);
  });
  for (let i = 0; i < 15 && !f.calls.some((request) => request.ca === ca(2)); i++) await f.step();
  assert.equal(f.calls.filter((request) => request.ca === ca(1)).length, 3);
  assert.ok(f.calls.some((request) => request.ca === ca(2)));
  assert.equal(f.state().assets.find((asset) => asset.ca === ca(1))!.admitted, false);
});

test('磁盘重开保持历史游标和任务计数；没有有效观察池或disabled只定时等待', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'gmgn-collector-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'db.sqlite');
  const f = fixture(t, [{ ca: ca(1) }], filename);
  await f.step(); await f.step();
  const before = f.state();
  f.collector().stop(); f.db.close();
  const reopened = openDatabase(filename); t.after(() => { if (reopened.open) reopened.close(); });
  const requests: Request[] = [];
  let now = T + 10000;
  const client = { setRateLimitStore(_store: RateLimitStore) {}, async getCandles15m(chain: string, address: string, range: { from: number; to: number }) {
    const request = { chain, ca: address, ...range, at: now }; requests.push(request); return result(request);
  } };
  const restarted = createGmgnCollector({ db: reopened, cfg: f.cfg, client, clock: () => now });
  await restarted.collectOnce();
  assert.equal(requests.length, 1); assert.equal(requests[0]!.to, before.assets[0]!.historyTo);
  const saved = JSON.parse((reopened.prepare("SELECT payload FROM runtime_state WHERE key='gmgn_state'").get() as { payload: string }).payload) as Persisted;
  assert.equal(saved.requests, before.requests + 1);
  restarted.stop(); now += 10000;
  f.cfg.kline.gmgn.enabled = false;
  const disabled = createGmgnCollector({ db: reopened, cfg: f.cfg, client, clock: () => now });
  const report = await disabled.collectOnce();
  assert.equal(report!.attempted, false); assert.ok(report!.nextAt >= now + 60000);
  assert.equal(requests.length, 1);
});

test('损坏gmgn_state不清空重建队列、不访问API，也不公开原payload', async (t) => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO runtime_state VALUES (?,?,?)').run('gmgn_state', '{PRIVATE_STATE_SECRET', T);
  const report = await f.step();
  assert.equal(report!.attempted, false); assert.equal(f.calls.length, 0);
  assert.equal(f.status().lastErrorCode, 'GMGN_STATE');
  assert.ok(!JSON.stringify(f.status()).includes('PRIVATE_STATE_SECRET'));
  assert.equal((f.db.prepare("SELECT payload FROM runtime_state WHERE key='gmgn_state'").get() as { payload: string }).payload, '{PRIVATE_STATE_SECRET');
});
