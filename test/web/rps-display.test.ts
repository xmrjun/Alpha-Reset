import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { loadStrategy } from '../../src/config/strategy.js';
import { emptyScores, INTERVAL_MS } from '../../src/market.js';
import { openDatabase } from '../../src/store/db.js';
import { createPoolStore } from '../../src/store/pool.js';
import { createRuntimeStore, initialRound, pendingMember } from '../../src/store/runtime.js';
import { createSeriesStore } from '../../src/store/series.js';
import { readMarketInputs } from '../../src/store/snapshot.js';
import { dataQuality } from '../../src/web/queries.js';
import { readRpsDisplay } from '../../src/web/rps-display.js';
import { createWebServer } from '../../src/web/server.js';
import { SAMPLE_STRATEGY, candle, poolItem } from '../helpers.js';

const httpFetch = globalThis.fetch;
const quarter = INTERVAL_MS['15m'];
const at = 1000 * quarter;
function fixture() {
  const db = openDatabase(':memory:');
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  const pools = createPoolStore(db);
  pools.upsertPool([poolItem('asset-a', { chain: 'solana' })], at);
  const series = createSeriesStore(db);
  const identity = series.ensureSeries({ source: 'geckoterminal', network: 'solana', ca: 'asset-a',
    poolAddress: 'pool-a', currency: 'usd', formatVersion: 1 }, at);
  series.upsertCandles(identity.id, '15m', [candle(at - quarter, 10)]);
  series.activateSeries(identity.id, at);
  const member = { ...pendingMember(pools.getPoolItem('asset-a')!, 1), seriesId: identity.id,
    klineStatus: 'ready' as const, rpsScores: { ...emptyScores(), r16: 92 } };
  const runtime = createRuntimeStore(db);
  const finished = { ...initialRound(cfg, at), status: 'complete' as const, boardComplete: true, completedAt: at,
    members: [member] };
  finished.coverage.r16 = { eligible: 100, available: 100, complete: true, source: 'kline' };
  runtime.saveRound(finished);
  return { db, cfg, runtime, finished, member, series, identity };
}

test('采集期间展示上轮真实分数与时间，但当前规则分数、A4与标签仍为空', async (t) => {
  const f = fixture(); t.after(() => f.db.close());
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Web 不得访问上游'); });
  const now = at + quarter;
  const running = { ...initialRound(f.cfg, now), boardComplete: true,
    members: [{ ...f.member, rpsScores: emptyScores(), klineStatus: 'skipped' as const }] };
  f.runtime.saveRound(running);
  const display = readRpsDisplay(f.db, f.cfg, now);
  assert.equal(display.summary?.state, 'previous');
  assert.equal(display.summary?.asOf, at);
  assert.equal(display.summary?.computedAt, at);
  assert.equal(display.byCa.get('asset-a')?.scores.r16, 92);
  assert.equal(readMarketInputs(f.db, f.cfg, now)[0]!.rpsScores.r16, null);

  const server = createWebServer({ db: f.db, cfg: f.cfg, now: () => now });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await httpFetch(`http://127.0.0.1:${address.port}/api/pool`);
    const result = await response.json();
    assert.equal(result.items[0].displayRps.scores.r16, 92);
    assert.equal(result.items[0].displayRps.state, 'previous');
    assert.equal(result.items[0].rpsScores.r16, null);
    assert.equal(result.items[0].reasons.a4, false);
    assert.deepEqual(result.items[0].tags, []);
    assert.equal(dataQuality(f.db, f.cfg, now).rpsAvailable, false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('展示缓存过期时保留历史值并标为stale，原始基准和完成时间不刷新', (t) => {
  const f = fixture(); t.after(() => f.db.close());
  const now = at + f.cfg.schedule.mainLoopMinutes * 60_000 + 1;
  const display = readRpsDisplay(f.db, f.cfg, now);
  assert.equal(display.summary?.state, 'stale');
  assert.equal(display.summary?.asOf, at);
  assert.equal(display.summary?.computedAt, at);
  assert.equal(display.byCa.get('asset-a')?.scores.r16, 92);
  assert.equal(readMarketInputs(f.db, f.cfg, now)[0]!.rpsScores.r16, null);
});

test('新成员、换链、换序列和策略变化不继承旧展示分数', (t) => {
  const f = fixture(); t.after(() => f.db.close());
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Web 不得访问上游'); });
  const now = at + quarter;
  const running = { ...initialRound(f.cfg, now), boardComplete: true, members: [
    { ...f.member, pool: { ...f.member.pool, ca: 'asset-b' }, rpsScores: emptyScores() },
    { ...f.member, pool: { ...f.member.pool, chain: 'bsc' }, rpsScores: emptyScores() },
  ] };
  f.runtime.saveRound(running);
  assert.equal(readRpsDisplay(f.db, f.cfg, now).byCa.size, 0);
  const changed = f.series.ensureSeries({ source: 'geckoterminal', network: 'solana', ca: 'asset-a',
    poolAddress: 'pool-changed', currency: 'usd', formatVersion: 1 }, now);
  running.members = [{ ...f.member, seriesId: changed.id, rpsScores: emptyScores() }];
  f.runtime.saveRound(running);
  assert.equal(readRpsDisplay(f.db, f.cfg, now).byCa.size, 0);
  const cfg = structuredClone(f.cfg);
  cfg.a4_rps.minCoverage = 0.99;
  assert.equal(readRpsDisplay(f.db, cfg, now).summary, null);
});

test('本轮端点进度基于startedAt，跨15m边界不会归零；可发现已写入但未发布的身份', (t) => {
  const f = fixture(); t.after(() => f.db.close());
  const running = { ...initialRound(f.cfg, at), boardComplete: true, members: [
    { ...f.member, seriesId: null, klineStatus: 'skipped' as const, rpsScores: emptyScores() },
  ] };
  f.runtime.saveRound(running);
  const quality = dataQuality(f.db, f.cfg, at + quarter + 1000);
  assert.equal(quality.freshPriceCount, 1);
  assert.equal(quality.collection.baselineAt, at);
  assert.equal(quality.collection.historyAvailable, 1);
  assert.equal(quality.collection.processed, 0);
  assert.equal(quality.monitored, 1);
  assert.equal(quality.rpsAvailable, false);
});

test('首轮尚无完整评分时，不从局部行情编造RPS', (t) => {
  const f = fixture(); t.after(() => f.db.close());
  f.db.prepare("DELETE FROM runtime_state WHERE key IN ('last_round','last_rps_round')").run();
  f.runtime.saveRound({ ...initialRound(f.cfg, at), boardComplete: true, members: [
    { ...f.member, rpsScores: emptyScores() },
  ] });
  const display = readRpsDisplay(f.db, f.cfg, at);
  assert.equal(display.summary, null);
  assert.equal(display.byCa.size, 0);
  assert.equal(dataQuality(f.db, f.cfg, at).collection.processed, 1);
  assert.equal(dataQuality(f.db, f.cfg, at).freshPriceCount, 1);
});


test('采集归档换链不会把上一计算时点的评分贴到另一链，当前标签固定原基准', async (t) => {
  const f = fixture(); t.after(() => f.db.close());
  createPoolStore(f.db).upsertPool([poolItem('asset-a', { chain: 'bsc' })], at + quarter);
  const input = readMarketInputs(f.db, f.cfg, at + quarter)[0]!;
  assert.equal(input.now, at);
  assert.equal(input.pool.chain, 'solana');
  const server = createWebServer({ db: f.db, cfg: f.cfg, now: () => at + quarter });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await httpFetch(`http://127.0.0.1:${address.port}/api/pool`);
    const result = await response.json();
    assert.equal(result.items[0].chain, 'solana');
    assert.equal(result.items[0].displayRps.scores.r16, 92);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
