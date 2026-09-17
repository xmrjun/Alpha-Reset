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
import { SocialLookup } from '../../src/web/social-lookup.js';
import { SAMPLE_STRATEGY, candle, poolItem } from '../helpers.js';

const httpFetch = globalThis.fetch;
const quarter = INTERVAL_MS['15m'];
const at = 1000 * quarter;
const next = at + 2 * quarter;

const IN_POOL = '0x648a5382bdcf286e7ff5122d01a983db314e620a';
const OUTSIDE = '0x1111111111111111111111111111111111111111';

function fakeSocial() {
  let calls = 0;
  const lookup = new SocialLookup({
    client: { async searchMentions() { calls += 1; return { posts: [], costUsd: 0.0001, skipped: 0 }; } },
    clock: () => next, dailyLimit: 100, perClientLimit: 100, cacheMs: 600_000,
  });
  return { lookup, upstreamCalls: () => calls };
}

async function serve(t: TestContext, social: SocialLookup) {
  const db = openDatabase(':memory:');
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  const runtime = createRuntimeStore(db);
  const pools = createPoolStore(db);
  const series = createSeriesStore(db);
  pools.upsertPool([poolItem(IN_POOL, { chain: 'arc' })], at);
  const identity = series.ensureSeries({ source: 'geckoterminal', network: 'arc', ca: IN_POOL,
    poolAddress: 'pool-x', currency: 'usd', formatVersion: 1 }, at);
  series.upsertCandles(identity.id, '15m', [candle(at - quarter, 10), candle(next - quarter, 20)]);
  series.activateSeries(identity.id, at);
  const member: RoundMember = { ...pendingMember(pools.getPoolItem(IN_POOL)!, 1), seriesId: identity.id,
    klineStatus: 'ready', rpsScores: { ...emptyScores(), r16: 92 },
    result: { passed: true, reasons: { a1: true, a2: true, a3: true, a4: true }, tags: [], newMoments: [] } };
  runtime.saveRound({ ...initialRound(cfg, next), members: [member], sourceCount: 1,
    boardComplete: true, status: 'complete' as const, completedAt: next });

  const server = createWebServer({ db, cfg, now: () => next + 1000, liveIntervalMs: 20, social });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { server.emit('shutdown'); await new Promise<void>((r) => server.close(() => r())); db.close(); });
  return async (body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
    httpFetch(origin + '/api/agent/tool', { method: 'POST', headers, body: JSON.stringify(body) });
}

test('social_check 只能查观察池里的币，池外地址在花钱之前就被拒', async (t) => {
  const { lookup, upstreamCalls } = fakeSocial();
  const post = await serve(t, lookup);

  const outside = await post({ name: 'social_check', arguments: { ca: OUTSIDE } });
  assert.equal(outside.status, 400, '池外地址必须被拒');
  assert.equal(upstreamCalls(), 0, '被拒时一次上游都不该打');

  const inside = await post({ name: 'social_check', arguments: { ca: IN_POOL } });
  assert.equal(inside.status, 200, '池内地址应当放行');
  assert.equal(upstreamCalls(), 1);
});

test('同一个 EVM 地址大小写不同时算同一个，不会重复付费', async (t) => {
  const { lookup, upstreamCalls } = fakeSocial();
  const post = await serve(t, lookup);
  await post({ name: 'social_check', arguments: { ca: IN_POOL } });
  await post({ name: 'social_check', arguments: { ca: IN_POOL.toUpperCase().replace('0X', '0x') } });
  assert.equal(upstreamCalls(), 1, '大小写差异不该产生第二条缓存');
});

test('非 JSON 请求被拒，断掉跨站表单强制消费这条路', async (t) => {
  const { lookup, upstreamCalls } = fakeSocial();
  const post = await serve(t, lookup);
  const response = await post({ name: 'social_check', arguments: { ca: IN_POOL } },
    { 'Content-Type': 'text/plain' });
  assert.equal(response.status, 415);
  assert.equal(upstreamCalls(), 0);
});

test('响应不对外播报预算余额，免得攻击者拿它判断有没有打穿', async (t) => {
  const { lookup } = fakeSocial();
  const post = await serve(t, lookup);
  const body = await (await post({ name: 'social_check', arguments: { ca: IN_POOL } })).json() as
    { result: Record<string, unknown> };
  assert.ok(!('usedToday' in body.result), '不该把今日用量透给匿名调用方');
  assert.ok(!('dailyLimit' in body.result), '不该把全局额度透给匿名调用方');
  assert.equal(body.result.verdict, 'quiet', '正常字段仍在');
});

test('既有只读工具不受影响', async (t) => {
  const { lookup } = fakeSocial();
  const post = await serve(t, lookup);
  assert.equal((await post({ name: 'query_coverage', arguments: {} })).status, 200);
  assert.equal((await post({ name: 'query_pool', arguments: { limit: 5 } })).status, 200);
});
