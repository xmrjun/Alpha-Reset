import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { createWebServer } from '../../src/web/server.js';
import { openDatabase } from '../../src/store/db.js';
import { createOutcomeStore, type CohortEntry } from '../../src/store/outcomes.js';
import { loadStrategy } from '../../src/config/strategy.js';
import { HOUR_MS } from '../../src/market.js';
import type { OutcomesResponse } from '../../src/web/contracts.js';
import { SAMPLE_STRATEGY } from '../helpers.js';

const httpFetch = globalThis.fetch;
const T = 100 * 24 * HOUR_MS;
const now = T + 48 * HOUR_MS;

async function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  const store = createOutcomeStore(db);
  const server = createWebServer({ db, cfg, now: () => now });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); });
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Web 不可访问上游 API'); });
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const get = async (path: string) => {
    const response = await httpFetch(origin + path, { headers: { Accept: 'application/json' } });
    return { status: response.status, body: await response.json() as OutcomesResponse };
  };
  return { db, store, get };
}
const entry = (over: Partial<CohortEntry> = {}): CohortEntry => ({
  ca: 'a', baselineAt: T, horizonHours: 1, alerted: true, tags: ['low_vol_30m'],
  seriesId: null, entryPrice: 100, ...over,
});

test('事后表现接口只读本地聚合，触发组与对照组分开返回', async (t) => {
  const { store, get } = await fixture(t);
  store.recordCohort([
    entry({ ca: 'hit1' }), entry({ ca: 'hit2' }),
    entry({ ca: 'ctl1', alerted: false, tags: [] }),
  ], T);
  for (const row of store.pending(now)) {
    store.settle(row, row.ca === 'hit1' ? 120 : row.ca === 'hit2' ? 110 : 95, now);
  }
  const { status, body } = await get('/api/outcomes');
  assert.equal(status, 200);
  const row = body.horizons.find((x) => x.horizonHours === 1)!;
  assert.equal(row.alerted.n, 2);
  assert.ok(Math.abs(row.alerted.median! - 15) < 1e-9);
  assert.equal(row.alerted.winRate, 100);
  assert.equal(row.control.n, 1);
  assert.ok(Math.abs(row.control.median! + 5) < 1e-9);
  assert.equal(row.control.winRate, 0);
  assert.equal(body.controlSince, T, '对照组起始时点如实返回');
  assert.equal(body.pending, 0);
});

test('对照组为空时 controlSince 为 null，不能让页面误以为已有基准', async (t) => {
  const { store, get } = await fixture(t);
  store.recordCohort([entry()], T);
  for (const row of store.pending(now)) store.settle(row, 150, now);
  const { body } = await get('/api/outcomes');
  assert.equal(body.horizons[0]!.alerted.n, 1);
  assert.equal(body.horizons[0]!.control.n, 0);
  assert.equal(body.horizons[0]!.control.median, null);
  assert.equal(body.controlSince, null);
});

test('待结算计数只算尚未尝试过的行，取不到退出价的不再计入', async (t) => {
  const { store, get } = await fixture(t);
  store.recordCohort([entry({ ca: 'x', horizonHours: 1 }), entry({ ca: 'y', horizonHours: 24 })], T);
  assert.equal((await get('/api/outcomes')).body.pending, 2);
  const due = store.pending(now).find((r) => r.ca === 'x')!;
  store.settle(due, null, now);   // 到期但取不到同源退出价
  assert.equal((await get('/api/outcomes')).body.pending, 1, '已尝试过的不再计入待结算');
});

test('since 参数裁剪统计窗口，非法取值被拒绝', async (t) => {
  const { store, get } = await fixture(t);
  store.recordCohort([entry({ ca: 'old', baselineAt: T - 24 * HOUR_MS }), entry({ ca: 'new' })], T);
  for (const row of store.pending(now)) store.settle(row, row.ca === 'old' ? 50 : 200, now);
  assert.equal((await get('/api/outcomes')).body.horizons[0]!.alerted.n, 2);
  assert.equal((await get(`/api/outcomes?since=${T}`)).body.horizons[0]!.alerted.n, 1);
  assert.equal((await get('/api/outcomes?since=-1')).status, 400);
  assert.equal((await get('/api/outcomes?since=abc')).status, 400);
});

test('按标签聚合逐标签计入，同一事件在每个标签下各出现一次', async (t) => {
  const { store, get } = await fixture(t);
  store.recordCohort([entry({ ca: 'a', tags: ['low_vol_30m', 'rsi_lt50_4h'] })], T);
  for (const row of store.pending(now)) store.settle(row, 130, now);
  const { body } = await get('/api/outcomes');
  assert.deepEqual(body.tags.map((x) => x.tag).sort(), ['low_vol_30m', 'rsi_lt50_4h']);
  for (const tag of body.tags) { assert.equal(tag.n, 1); assert.ok(Math.abs(tag.median! - 30) < 1e-9); }
});
