import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { loadStrategy } from '../../src/config/strategy.js';
import { emptyScores, INTERVAL_MS } from '../../src/market.js';
import { openDatabase } from '../../src/store/db.js';
import { createPoolStore } from '../../src/store/pool.js';
import { createRuntimeStore, initialRound, pendingMember, type RoundMember } from '../../src/store/runtime.js';
import { createSeriesStore } from '../../src/store/series.js';
import { readRpsDisplay } from '../../src/web/rps-display.js';
import { createWebServer } from '../../src/web/server.js';
import { SAMPLE_STRATEGY, candle, poolItem } from '../helpers.js';

const httpFetch = globalThis.fetch;
const quarter = INTERVAL_MS['15m'];
const at = 1000 * quarter;

function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  cfg.kline.requestsPerMinute = 8;
  cfg.pool.refreshMinutes = 5;
  const runtime = createRuntimeStore(db);
  const pools = createPoolStore(db);
  const series = createSeriesStore(db);
  const member = (ca: string, chain = 'solana', address = 'pool-' + ca): RoundMember => {
    pools.upsertPool([poolItem(ca, { chain, marketCap: 100_000 })], at);
    const identity = series.ensureSeries({ source: 'geckoterminal', network: chain, ca,
      poolAddress: address, currency: 'usd', formatVersion: 1 }, at);
    series.upsertCandles(identity.id, '15m', [candle(at - quarter, 10)]);
    series.activateSeries(identity.id, at);
    return { ...pendingMember(pools.getPoolItem(ca)!, 1), seriesId: identity.id,
      klineStatus: 'ready', rpsScores: { ...emptyScores(), r16: 92 },
      result: { passed: true, reasons: { a1: true, a2: true, a3: true, a4: true },
        tags: ['low_vol_30m'], newMoments: [] } };
  };
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('观察池 Web 不得访问上游'); });
  return { db, cfg, runtime, pools, series, member };
}

async function serve(t: TestContext, f: ReturnType<typeof fixture>, now: number) {
  const server = createWebServer({ db: f.db, cfg: f.cfg, now: () => now });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    server.emit('shutdown');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.db.close();
  });
  return async (path: string) => {
    const response = await httpFetch(`http://127.0.0.1:${address.port}${path}`);
    assert.equal(response.status, 200, path);
    return response.json();
  };
}

test('最新完整名单立即取代旧列表，统计不读归档累计；匹配行保留固定 T，新增换链不继承评分', async (t) => {
  const f = fixture(t);
  const old = [f.member('a'), f.member('c'), f.member('removed')];
  const completed = { ...initialRound(f.cfg, at), boardComplete: true, status: 'complete' as const,
    completedAt: at, sourceCount: 3, members: old };
  f.runtime.saveRound(completed);
  f.runtime.saveCollectionRound({ ...completed, status: 'running', completedAt: null }, false);
  f.pools.upsertPool([poolItem('archive-only')], at);
  const get = await serve(t, f, at + 5 * 60_000);
  assert.equal((await get('/api/stats')).poolSize, 3);
  const changedChain = f.member('c', 'bsc');
  const added = f.member('new');
  const another = f.member('another');
  const latest = { ...initialRound(f.cfg, at + 60_000), boardComplete: true, sourceCount: 4,
    sourceLimited: true, observedAt: at + 4 * 60_000, addedCount: 3, removedCount: 2,
    members: [{ ...old[0]!, pool: { ...old[0]!.pool, marketCap: 9_000_000 } }, changedChain, added, another] };
  f.runtime.saveObservationRound(latest);

  const body = await get('/api/pool?limit=1000');
  assert.equal(body.total, 4);
  assert.equal(body.updatedAt, latest.observedAt);
  assert.deepEqual(body.items.map((row: { ca: string }) => row.ca).sort(), ['a', 'another', 'c', 'new']);
  const retained = body.items.find((row: { ca: string }) => row.ca === 'a');
  assert.equal(retained.marketCap, 100_000, '当前规则行使用固定 T 元数据，不借最新归档覆盖');
  assert.equal(retained.rpsScores.r16, 92);
  assert.equal(retained.displayRps.scores.r16, 92);
  assert.deepEqual(retained.tags, ['low_vol_30m'], '使用已经发布的固定 T 规则结果');
  assert.equal(retained.calculationPending, false);
  for (const ca of ['c', 'new', 'another']) {
    const row = body.items.find((item: { ca: string }) => item.ca === ca);
    assert.deepEqual(row.rpsScores, emptyScores());
    assert.equal(row.displayRps, null);
    assert.deepEqual(row.tags, []);
    assert.equal(row.calculationPending, true);
  }
  assert.equal(body.items.find((row: { ca: string }) => row.ca === 'c').chain, 'bsc');
  const stats = await get('/api/stats');
  assert.equal(stats.poolSize, 4);
  assert.equal(stats.lastRunAt, latest.observedAt);
  assert.deepEqual(stats.dataQuality.observation, { sourceCount: 4, memberCount: 4,
    updatedAt: latest.observedAt, refreshMinutes: 5, upstreamLimited: true, addedCount: 3, removedCount: 2 });
  assert.equal(stats.dataQuality.calculation.memberCount, 3);
  assert.equal(stats.dataQuality.calculation.asOf, at);
  assert.equal(stats.dataQuality.collection.memberCount, 3);
  assert.equal(stats.dataQuality.monitored, 3);
  assert.equal(stats.dataQuality.collection.effectiveRpm, 8);
  assert.equal(stats.dataQuality.collection.minSweepMinutes, 3 / 8);
  assert.equal(stats.dataQuality.mayBeTruncated, true);
  assert.equal(f.runtime.getRound()!.members.length, 3, '只读页面不改变固定 T 的排名分母');
});

test('首个完整观察名单无需等待 RPS 即可展示；详情读取新成员当前已验证序列', async (t) => {
  const f = fixture(t);
  const member = f.member('brand-new');
  f.runtime.saveObservationRound({ ...initialRound(f.cfg, at), boardComplete: true,
    sourceCount: 1, observedAt: at + 1, members: [member] });
  const get = await serve(t, f, at + 1000);
  const body = await get('/api/pool');
  assert.equal(body.total, 1);
  assert.equal(body.items[0].ca, 'brand-new');
  assert.deepEqual(body.items[0].rpsScores, emptyScores());
  assert.deepEqual(body.items[0].tags, []);
  assert.equal(body.items[0].displayRps, null);
  const stats = await get('/api/stats');
  assert.equal(stats.poolSize, 1);
  assert.equal(stats.dataQuality.calculation.memberCount, 0);
  const detail = await get('/api/ca/brand-new');
  assert.equal(detail.pool.ca, 'brand-new');
  assert.equal(detail.pool.chain, 'solana');
  assert.equal(detail.marketSeries.id, member.seriesId);
});

test('同 CA 同链显式切换序列时，旧固定池评分不能贴给新序列', async (t) => {
  const f = fixture(t);
  const original = f.member('a');
  f.runtime.saveRound({ ...initialRound(f.cfg, at), status: 'complete', completedAt: at,
    boardComplete: true, sourceCount: 1, members: [original] });
  f.db.prepare('UPDATE market_series SET active = 0 WHERE id = ?').run(original.seriesId);
  const replacement = f.member('a', 'solana', 'explicitly-replaced-pool');
  f.runtime.saveObservationRound({ ...initialRound(f.cfg, at + 1), boardComplete: true,
    sourceCount: 1, observedAt: at + 2, members: [replacement] });
  const get = await serve(t, f, at + 1000);
  const result = await get('/api/pool');
  assert.deepEqual(result.items[0].rpsScores, emptyScores());
  assert.deepEqual(result.items[0].tags, []);
  assert.equal(result.items[0].displayRps, null);
  assert.equal(readRpsDisplay(f.db, f.cfg, at + 1000).byCa.size, 0);
});


test('发现运行和失败状态独立发布，失败不改最后完整名单及成功更新时间', async (t) => {
  const f = fixture(t);
  const member = f.member('retained');
  const successful = { ...initialRound(f.cfg, at), boardComplete: true, status: 'complete' as const,
    sourceCount: 1, observedAt: at + 1000, completedAt: at + 2000, members: [member] };
  f.runtime.saveObservationRound(successful);
  const get = await serve(t, f, at + 10 * 60_000);
  const attempt = initialRound(f.cfg, at + 5 * 60_000);
  f.runtime.saveDiscoveryRound(attempt);
  const running = await get('/api/stats');
  assert.equal(running.dataQuality.observation.discoveryStatus, 'running');
  assert.equal(running.dataQuality.observation.discoveryFailures, 0);
  assert.equal(running.dataQuality.observation.lastAttemptAt, attempt.startedAt);
  assert.equal(running.dataQuality.observation.updatedAt, successful.observedAt);

  f.runtime.saveDiscoveryRound({ ...attempt, status: 'failed', completedAt: at + 6 * 60_000, failures: 1 });
  const failed = await get('/api/stats');
  assert.equal(failed.poolSize, 1);
  assert.equal(failed.lastRunAt, successful.observedAt);
  assert.equal(failed.dataQuality.observation.updatedAt, successful.observedAt);
  assert.equal(failed.dataQuality.observation.discoveryStatus, 'failed');
  assert.equal(failed.dataQuality.observation.discoveryFailures, 1);
  assert.equal(failed.dataQuality.observation.lastAttemptAt, attempt.startedAt);
  const pool = await get('/api/pool');
  assert.equal(pool.updatedAt, successful.observedAt);
  assert.deepEqual(pool.items.map((row: { ca: string }) => row.ca), ['retained']);

  f.runtime.saveDiscoveryRound({ ...attempt, status: 'halted', completedAt: at + 7 * 60_000 });
  assert.equal((await get('/api/stats')).dataQuality.observation.discoveryStatus, 'halted');
  // 其他配置的尝试不得污染当前页面，也不得退回旧的成功时间。
  f.runtime.saveDiscoveryRound({ ...attempt, strategyKey: 'different-strategy', status: 'failed', failures: 9 });
  const incompatible = (await get('/api/stats')).dataQuality.observation;
  assert.equal(incompatible.discoveryStatus, undefined);
  assert.equal(incompatible.discoveryFailures, undefined);
  assert.equal(incompatible.lastAttemptAt, undefined);
  assert.equal(incompatible.updatedAt, successful.observedAt);
});
