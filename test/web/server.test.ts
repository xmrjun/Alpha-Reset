import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { createWebServer } from '../../src/web/server.js';
import { openDatabase } from '../../src/store/db.js';
import { createPoolStore } from '../../src/store/pool.js';
import { createCandleStore } from '../../src/store/candles.js';
import { createAlertStore } from '../../src/store/alerts.js';
import { createRuntimeStore, initialRound, pendingMember } from '../../src/store/runtime.js';
import { loadStrategy } from '../../src/config/strategy.js';
import { queryAlertGroups } from '../../src/web/queries.js';
import { HOUR_MS, emptyScores } from '../../src/market.js';
import { emptyBounds } from '../../src/indicators/observation-rps.js';
import { SAMPLE_STRATEGY, candle, poolItem } from '../helpers.js';

const httpFetch = globalThis.fetch;
const now = (100 * 24 + 12) * HOUR_MS;
async function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  createPoolStore(db).upsertPool([{ ...poolItem('a', { marketCap: 100_000 }), listedAt: 0 },
    { ...poolItem('b', { marketCap: 200_000, chain: 'bsc', groupName: '示例群组二' }), listedAt: 0 }], now);
  createCandleStore(db).upsertCandles('a', '15m', Array.from({ length: 100 }, (_, i) => candle(now - (100 - i) * HOUR_MS / 4, 10 + i)));
  const alerts = createAlertStore(db);
  alerts.recordAlert({ ca: 'a', tag: 'low_vol_30m', firedAt: now - 1000, payload: { rsi: 30 }, pushed: true });
  alerts.recordAlert({ ca: 'a', tag: 'rsi_lt50_4h', firedAt: now - 1000, payload: { rsi: 30 }, pushed: true });
  alerts.recordAlert({ ca: 'b', tag: 'low_vol_60m', firedAt: now, payload: { dryRun: true } });
  // readMarketInputs 依赖 runtime_state 的轮次快照，缺它会直接返回空池
  const state = createRuntimeStore(db);
  const round = initialRound(cfg, now);
  round.status = 'complete';
  round.completedAt = now;
  round.boardComplete = true;
  round.members = createPoolStore(db).getPool().map((row) => pendingMember(row, 1));
  state.saveRound(round);

  const server = createWebServer({ db, cfg, now: () => now });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); });
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Web 不可访问上游 API'); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { db, cfg, get: (path: string, init?: RequestInit) => httpFetch(`http://127.0.0.1:${address.port}${path}`, init) };
}

test('观察池筛选、排序、总数和响应字段一致；读取过程零上游请求', async (t) => {
  const { get } = await fixture(t);
  const response = await get('/api/pool?sort=-marketCap&limit=1');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.total, 2);
  assert.equal(body.items[0].ca, 'b');
  assert.equal(body.items[0].marketCap, 200_000);
  assert.ok('rpsScores' in body.items[0]);
  assert.equal((await (await get('/api/pool?chain=solana&group=示例群组一')).json()).total, 1);
  assert.equal((await (await get('/api/pool?hit=1')).json()).total, 0);
});

test('告警分页按合并消息计数，标签筛选仍保留同条消息的全部标签', async (t) => {
  const { get } = await fixture(t);
  const result = await (await get('/api/alerts?limit=1')).json();
  assert.equal(result.total, 2);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].ca, 'b');
  const filtered = await (await get('/api/alerts?tag=low_vol_30m')).json();
  assert.equal(filtered.total, 1);
  assert.deepEqual([...filtered.items[0].tags].sort(), ['low_vol_30m', 'rsi_lt50_4h']);
  assert.equal(filtered.items[0].pushed, true);
});

test('详情合成 30m 并对齐完整历史 RSI/MA，limit 仅裁剪显示窗口', async (t) => {
  const { get } = await fixture(t);
  const result = await (await get('/api/ca/a?interval=30m&limit=5')).json();
  assert.equal(result.candles.length, 5);
  assert.equal(result.candles[0].openTime < result.candles[4].openTime, true);
  assert.equal(result.indicators.rsi.length, 5);
  assert.equal(result.indicators.volumeMa.length, 5);
  assert.equal(result.indicators.parameters.volMaPeriod, 39);
  assert.equal(result.alerts.length, 1);
  assert.equal((await get('/api/ca/missing')).status, 404);
});

test('统计按成功推送的合并消息计数，干跑不算今日推送', async (t) => {
  const { get } = await fixture(t);
  const stats = await (await get('/api/stats')).json();
  assert.equal(stats.poolSize, 2);
  assert.equal(stats.alertsToday, 1);
  assert.equal(stats.quota.limit, 10_500);
  assert.equal(stats.dataQuality.freshPriceCount, 1);
  assert.equal(stats.dataQuality.rpsAvailable, false);
});

test('非法查询、SQL 注入、非法路径和不支持的方法可识别拒绝', async (t) => {
  const { get } = await fixture(t);
  for (const path of ['/api/pool?limit=-1', '/api/pool?sort=DROP%20TABLE', '/api/ca/a?interval=15m',
    '/api/alerts?tag=unknown', '/api/alerts?from=20&to=10', '/api/ca/%ZZ']) {
    assert.equal((await get(path)).status, 400, path);
  }
  assert.equal((await get('/api/stats', { method: 'POST' })).status, 405);
  assert.equal((await get('/missing')).status, 404);
  assert.equal((await get('/api/pool?chain=%27%20OR%201=1')).status, 200);
});

test('合并记录只有部分标签发送成功时，不显示整组已推送', (t) => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const store = createAlertStore(db);
  store.recordAlert({ ca: 'a', tag: 'low_vol_30m', firedAt: now, payload: {}, pushed: true });
  const pending = store.recordAlert({ ca: 'a', tag: 'low_vol_4h', firedAt: now, payload: {} });
  assert.equal(queryAlertGroups(db).items[0]!.pushed, false);
  store.markPushed([pending]);
  assert.equal(queryAlertGroups(db).items[0]!.pushed, true);
});

test('Web区分完整排名和保守下界，过期时同时停止两类评分', async (t) => {
  const { get, db } = await fixture(t);
  const state = createRuntimeStore(db);
  const round = state.getRound()!;
  round.members[0]!.rpsScores = emptyScores();
  round.members[0]!.rpsBounds = { ...emptyBounds(), r16: { lower: 86, upper: 96, status: 'pass' } };
  round.coverage.r16 = { eligible: 100, available: 90, complete: false, source: 'kline', boundedPassCount: 1 };
  state.saveRound(round);
  const stats = await (await get('/api/stats')).json();
  assert.equal(stats.dataQuality.rpsAvailable, true);
  assert.deepEqual(stats.dataQuality.rpsReadyKeys, []);
  assert.deepEqual(stats.dataQuality.rpsBoundedKeys, ['r16']);
  const body = await (await get('/api/pool')).json();
  const row = body.items.find((item: { ca: string }) => item.ca === round.members[0]!.pool.ca);
  assert.equal(row.rpsScores.r16, null);
  assert.deepEqual(row.rpsBounds.r16, { lower: 86, upper: 96, status: 'pass' });
  assert.equal(row.reasons.a4, true);
  round.startedAt -= HOUR_MS;
  round.completedAt = now - HOUR_MS;
  state.saveRound(round);
  assert.equal((await (await get('/api/stats')).json()).dataQuality.rpsAvailable, false);
  const stale = await (await get('/api/pool')).json();
  for (const item of stale.items) {
    assert.equal(item.rpsScores.r16, null);
    assert.equal(item.rpsBounds, undefined);
    assert.equal(item.reasons.a4, false);
  }
});
