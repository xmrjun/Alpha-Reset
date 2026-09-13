import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { loadStrategy } from '../../src/config/strategy.js';
import { emptyScores, INTERVAL_MS } from '../../src/market.js';
import { openDatabase } from '../../src/store/db.js';
import { createPoolStore } from '../../src/store/pool.js';
import { createRuntimeStore, initialRound, pendingMember, type RoundMember } from '../../src/store/runtime.js';
import { createSeriesStore } from '../../src/store/series.js';
import { readMarketInputs } from '../../src/store/snapshot.js';
import { verifiedCalculationSeries } from '../../src/web/rps-display.js';
import { createWebServer } from '../../src/web/server.js';
import { SAMPLE_STRATEGY, candle, poolItem } from '../helpers.js';

const httpFetch = globalThis.fetch;
const quarter = INTERVAL_MS['15m'];
const at = 1000 * quarter;
const next = at + 2 * quarter;
async function message(socket: WebSocket) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      once(socket, 'message').then(([data]) => JSON.parse(data.toString())),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Local WS update timed out')), 3000); timeout.unref(); }),
    ]);
  } finally { if (timeout) clearTimeout(timeout); }
}
function fixture(t: TestContext) {
  const db = openDatabase(':memory:'); const cfg = loadStrategy(SAMPLE_STRATEGY);
  cfg.kline.gmgn.enabled = true;
  const runtime = createRuntimeStore(db); const pools = createPoolStore(db); const series = createSeriesStore(db);
  function member(ca: string, source: 'gmgn' | 'geckoterminal' | null, network = 'solana'): RoundMember {
    pools.upsertPool([poolItem(ca, { chain: network })], at);
    const pending = { ...pendingMember(pools.getPoolItem(ca)!, 1), seriesId: null };
    if (!source) return pending;
    const identity = series.ensureSeries(source === 'gmgn'
      ? { source, scope: 'token', network, ca, poolAddress: null, currency: 'usd', formatVersion: 1 }
      : { source, network, ca, poolAddress: 'pool-' + ca, currency: 'usd', formatVersion: 1 }, at);
    series.upsertCandles(identity.id, '15m', [candle(at - quarter, 10), candle(next - quarter, source === 'gmgn' ? 20 : 11)]);
    series.activateSeries(identity.id, at);
    return { ...pending, seriesId: identity.id, klineStatus: 'ready', rpsScores: { ...emptyScores(), r16: 92 },
      result: { passed: true, reasons: { a1: true, a2: true, a3: true, a4: true }, tags: ['low_vol_30m'], newMoments: [] } };
  }
  const completed = (members: RoundMember[], startedAt = at) => ({ ...initialRound(cfg, startedAt), members,
    sourceCount: members.length, boardComplete: true, status: 'complete' as const, completedAt: startedAt });
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Web 只读本地数据，不得请求行情'); });
  return { db, cfg, runtime, pools, series, member, completed };
}
async function serve(t: TestContext, f: ReturnType<typeof fixture>) {
  const server = createWebServer({ db: f.db, cfg: f.cfg, now: () => next + 1000, liveIntervalMs: 20 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { server.emit('shutdown'); await new Promise<void>(resolve => server.close(() => resolve())); f.db.close(); });
  return { origin, get: async (path: string) => { const response = await httpFetch(origin + path); assert.equal(response.status, 200); return response.json(); } };
}

test('新 T 改用 GMGN 时，观察缓存仍是 Gecko 也立即展示本 T 来源与新分数', async t => {
  const f = fixture(t); const old = f.member('a', 'geckoterminal');
  f.runtime.saveRound(f.completed([old]));
  f.runtime.saveObservationRound(f.completed([old]));
  f.db.prepare('UPDATE market_series SET active = 0 WHERE id = ?').run(old.seriesId);
  const selected = { ...f.member('a', 'gmgn'), rpsScores: { ...emptyScores(), r16: 73 },
    result: { passed: false, reasons: { a1: true, a2: true, a3: false, a4: false }, tags: [], newMoments: [] } };
  f.runtime.saveRound(f.completed([selected], next));
  assert.equal(f.runtime.getObservationRound()!.members[0]!.seriesId, old.seriesId);
  const { get } = await serve(t, f);
  const row = (await get('/api/pool')).items[0];
  assert.equal(row.scoreSource, 'gmgn'); assert.equal(row.calculationPending, false);
  assert.equal(row.rpsScores.r16, 73); assert.equal(row.displayRps.scores.r16, 73);
  assert.equal(row.displayRps.asOf, next); assert.deepEqual(row.tags, []);
  assert.deepEqual((await get('/api/stats')).dataQuality.calculation.sources, { gmgn: 1, geckoterminal: 0, unbound: 0 });
  const detail = await get('/api/ca/a');
  assert.equal(detail.marketSeries.source, 'gmgn'); assert.equal(detail.marketSeries.poolAddress, null);
});

test('同 T 仍按冻结 Gecko 读取，活动 GMGN 不能认领其旧分数或展示缓存', async t => {
  const f = fixture(t); const old = f.member('a', 'geckoterminal');
  f.runtime.saveRound(f.completed([old], next)); f.runtime.saveObservationRound(f.completed([old]));
  f.db.prepare('UPDATE market_series SET active = 0 WHERE id = ?').run(old.seriesId);
  f.member('a', 'gmgn');
  assert.equal(verifiedCalculationSeries(f.db, old)?.id, old.seriesId);
  assert.equal(verifiedCalculationSeries(f.db, old)?.active, false);
  assert.equal(readMarketInputs(f.db, f.cfg, next + 1000)[0]!.candles15m!.at(-1)!.close, 11);
  const { get } = await serve(t, f); const row = (await get('/api/pool')).items[0];
  assert.deepEqual(row.rpsScores, emptyScores()); assert.equal(row.displayRps, null);
  assert.equal(row.scoreSource, null); assert.equal(row.calculationPending, true); assert.deepEqual(row.tags, []);
  assert.deepEqual((await get('/api/stats')).dataQuality.calculation.sources, { gmgn: 0, geckoterminal: 1, unbound: 0 });
});

test('GMGN 状态白名单通过本地 WS 推送，Gecko 进度排除 GMGN 和其待采新成员', async t => {
  const f = fixture(t);
  const members = [f.member('gmgn', 'gmgn'), f.member('gecko', 'geckoterminal', 'bsc'),
    f.member('gmgn-pending', null), f.member('gecko-pending', null, 'avax')];
  const round = f.completed(members, next);
  f.runtime.saveRound(round); f.runtime.saveObservationRound(round);
  f.runtime.saveCollectionRound({ ...round, status: 'running', completedAt: null }, false);
  const status = { status: 'running', updatedAt: next, requests: 12, recentRequests: 4, historyRequests: 8,
    assetsWithHistory: 1, backfillPending: 2, cooldownUntil: 0, lastErrorCode: 'PRIVATE_SENTINEL',
    headers: { 'X-APIKEY': 'PRIVATE_SENTINEL' }, ca: 'PRIVATE_SENTINEL' };
  const put = f.db.prepare('INSERT INTO runtime_state(key,payload,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at');
  put.run('gmgn_status', JSON.stringify(status), next);
  const { origin, get } = await serve(t, f);
  const stats = await get('/api/stats');
  assert.deepEqual(stats.dataQuality.calculation.sources, { gmgn: 1, geckoterminal: 1, unbound: 2 });
  assert.equal(stats.dataQuality.collection.source, 'geckoterminal');
  assert.equal(stats.dataQuality.collection.memberCount, 2); assert.equal(stats.dataQuality.collection.processed, 1);
  assert.equal(stats.dataQuality.freshPriceCount, 1); assert.equal(stats.dataQuality.gmgn.assetsWithHistory, 1);
  assert.equal(stats.dataQuality.gmgn.effectiveRpm, f.cfg.kline.gmgn.requestsPerMinute);
  assert.equal(JSON.stringify(stats).includes('PRIVATE_SENTINEL'), false);
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/live');
  t.after(() => socket.terminate());
  const first = await message(socket);
  const changed = message(socket);
  put.run('gmgn_status', JSON.stringify({ ...status, status: 'cooldown', cooldownUntil: next + 60_000 }), next + 1);
  const update = await changed;
  assert.notEqual(update.revision, first.revision);
  assert.equal(update.stats.dataQuality.gmgn.status, 'cooldown');
  assert.equal(update.stats.dataQuality.gmgn.cooldownUntil, next + 60_000);
  assert.equal(JSON.stringify(update).includes('PRIVATE_SENTINEL'), false);
  socket.close(); await once(socket, 'close');
});


test('新 T 成熟 GMGN 待当前端点时保留旧来源上一轮展示，首次绑定后立即换成新分', async t => {
  const f = fixture(t); const old = f.member('a', 'geckoterminal');
  const other = f.member('b', 'geckoterminal');
  const prior = { ...f.completed([old, other]), completedAt: at + 5 * 60_000 };
  f.runtime.saveRound(prior); f.runtime.saveObservationRound(prior);
  const waiting = { ...old, seriesId: null, plannedSource: 'gmgn' as const,
    rpsScores: emptyScores(), result: null };
  f.runtime.saveRound(f.completed([waiting, { ...other, rpsScores: { ...emptyScores(), r16: 61 } }], next));
  assert.equal(f.runtime.getRpsRound()!.startedAt, next, '其他成员新分已取代普通展示快照');
  const { get } = await serve(t, f);
  const pending = (await get('/api/pool')).items.find((row: { ca: string }) => row.ca === 'a');
  assert.deepEqual(pending.rpsScores, emptyScores()); assert.deepEqual(pending.tags, []);
  assert.equal(pending.scoreSource, null); assert.equal(pending.calculationPending, true);
  assert.equal(pending.displayRps.scores.r16, 92); assert.equal(pending.displayRps.source, 'geckoterminal');
  assert.equal(pending.displayRps.poolSize, 2);
  assert.equal(pending.displayRps.asOf, at); assert.equal(pending.displayRps.state, 'previous');
  f.db.prepare('UPDATE market_series SET active = 0 WHERE id = ?').run(old.seriesId);
  const selected = { ...f.member('a', 'gmgn'), rpsScores: { ...emptyScores(), r16: 73 },
    result: { passed: false, reasons: { a1: true, a2: true, a3: false, a4: false }, tags: [], newMoments: [] } };
  f.runtime.saveRound(f.completed([selected, other], next));
  const bound = (await get('/api/pool')).items.find((row: { ca: string }) => row.ca === 'a');
  assert.equal(bound.scoreSource, 'gmgn'); assert.equal(bound.calculationPending, false);
  assert.equal(bound.displayRps.scores.r16, 73); assert.equal(bound.displayRps.source, 'gmgn');
  assert.equal(bound.displayRps.asOf, next); assert.equal(bound.displayRps.state, 'current');
  assert.deepEqual(bound.tags, []);
});
