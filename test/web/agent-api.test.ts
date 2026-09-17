import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { loadStrategy } from '../../src/config/strategy.js';
import { emptyScores, INTERVAL_MS } from '../../src/market.js';
import { openDatabase } from '../../src/store/db.js';
import { createPoolStore } from '../../src/store/pool.js';
import { createRuntimeStore, initialRound, pendingMember, type RoundMember } from '../../src/store/runtime.js';
import { createSeriesStore } from '../../src/store/series.js';
import { createWebServer } from '../../src/web/server.js';
import { SAMPLE_STRATEGY, candle, poolItem } from '../helpers.js';

const httpFetch = globalThis.fetch;
const quarter = INTERVAL_MS['15m'];
const at = 1000 * quarter;
const next = at + 2 * quarter;

function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  const runtime = createRuntimeStore(db);
  const pools = createPoolStore(db);
  const series = createSeriesStore(db);
  function member(ca: string, chain = 'solana'): RoundMember {
    pools.upsertPool([poolItem(ca, { chain })], at);
    const pending = { ...pendingMember(pools.getPoolItem(ca)!, 1), seriesId: null };
    const identity = series.ensureSeries({ source: 'geckoterminal', network: chain, ca,
      poolAddress: 'pool-' + ca, currency: 'usd', formatVersion: 1 }, at);
    series.upsertCandles(identity.id, '15m', [candle(at - quarter, 10), candle(next - quarter, 20)]);
    series.activateSeries(identity.id, at);
    return { ...pending, seriesId: identity.id, klineStatus: 'ready', rpsScores: { ...emptyScores(), r16: 92 },
      result: { passed: true, reasons: { a1: true, a2: true, a3: true, a4: true }, tags: ['low_vol_30m'], newMoments: [] } };
  }
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('工具执行只读本地数据，不得发起外部请求'); });
  const round = { ...initialRound(cfg, next), members: [member('aaa')], sourceCount: 1,
    boardComplete: true, status: 'complete' as const, completedAt: next };
  runtime.saveRound(round);
  runtime.saveObservationRound(round);
  return { db, cfg };
}

async function serve(t: TestContext, f: ReturnType<typeof fixture>) {
  const server = createWebServer({ db: f.db, cfg: f.cfg, now: () => next + 1000, liveIntervalMs: 20 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { server.emit('shutdown'); await new Promise<void>((r) => server.close(() => r())); f.db.close(); });
  return {
    get: async (path: string) => httpFetch(origin + path),
    post: async (path: string, body: unknown) => httpFetch(origin + path,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  };
}

test('工具清单可通过 API 取到，前端据此告诉模型有哪些能力', async (t) => {
  const { get } = await serve(t, fixture(t));
  const response = await get('/api/agent/tools');
  assert.equal(response.status, 200);
  const body = await response.json() as { tools: { name: string }[] };
  const names = body.tools.map((tool) => tool.name);
  for (const expected of ['query_pool', 'query_alerts', 'query_coverage', 'diagnose']) {
    assert.ok(names.includes(expected), `工具清单缺少 ${expected}`);
  }
});

test('工具执行返回真实本地数据，不触发任何外部请求', async (t) => {
  const { post } = await serve(t, fixture(t));

  const coverage = await post('/api/agent/tool', { name: 'query_coverage', arguments: {} });
  assert.equal(coverage.status, 200);
  const cov = await coverage.json() as { result: Record<string, unknown> };
  assert.ok(cov.result, 'query_coverage 应返回结果');

  const pool = await post('/api/agent/tool', { name: 'query_pool', arguments: { limit: 5 } });
  assert.equal(pool.status, 200);
  const rows = await pool.json() as { result: { items?: unknown[] } };
  assert.ok(Array.isArray(rows.result.items), 'query_pool 应返回成员列表');
});

test('非法工具与非法参数被拦在查询层之前', async (t) => {
  const { post } = await serve(t, fixture(t));
  assert.equal((await post('/api/agent/tool', { name: 'drop_everything', arguments: {} })).status, 400);
  assert.equal((await post('/api/agent/tool', { name: 'query_pool', arguments: { limit: 9999 } })).status, 400);
  assert.equal((await post('/api/agent/tool', { name: 'query_pool', arguments: { evil: 1 } })).status, 400);
});

test('聊天代理缺少凭据时直接拒绝，绝不使用服务端自己的 key', async (t) => {
  const { post } = await serve(t, fixture(t));
  const response = await post('/api/agent/chat', { model: 'x', messages: [] });
  assert.equal(response.status, 400, '没有用户 key 就必须拒绝，不能回退到服务端凭据');
  const body = await response.json() as { error?: string };
  assert.equal(body.error, 'MISSING_KEY');
});

test('GET 请求仍然正常，新增 POST 路由没有破坏既有只读接口', async (t) => {
  const { get } = await serve(t, fixture(t));
  assert.equal((await get('/api/stats')).status, 200);
  assert.equal((await get('/api/pool')).status, 200);
});
