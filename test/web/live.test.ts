import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { loadStrategy } from '../../src/config/strategy.js';
import { emptyScores, INTERVAL_MS } from '../../src/market.js';
import { openDatabase } from '../../src/store/db.js';
import { createPoolStore } from '../../src/store/pool.js';
import { createRuntimeStore, initialRound, pendingMember } from '../../src/store/runtime.js';
import { createSeriesStore } from '../../src/store/series.js';
import { createWebServer } from '../../src/web/server.js';
import { SAMPLE_STRATEGY, candle, poolItem } from '../helpers.js';

const at = 1000 * INTERVAL_MS['15m'];
const nextMessage = (socket: WebSocket) => Promise.race([
  once(socket, 'message').then(([data]) => JSON.parse(data.toString())),
  new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('WS message timeout')), 3000); timer.unref(); }),
]);

test('WebSocket首连完整快照，数据库进度/RPS变化直接推送，重连恢复最新值', async (t) => {
  const db = openDatabase(':memory:');
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  const pools = createPoolStore(db); const runtime = createRuntimeStore(db);
  pools.upsertPool([poolItem('asset-a', { chain: 'solana' })], at);
  const series = createSeriesStore(db);
  const identity = series.ensureSeries({ source: 'geckoterminal', network: 'solana', ca: 'asset-a',
    poolAddress: 'pool-a', currency: 'usd', formatVersion: 1 }, at);
  series.upsertCandles(identity.id, '15m', [candle(at - INTERVAL_MS['15m'], 10)]);
  series.activateSeries(identity.id, at);
  const member = { ...pendingMember(pools.getPoolItem('asset-a')!, 1), seriesId: identity.id };
  const round = { ...initialRound(cfg, at), boardComplete: true, members: [member] };
  runtime.saveRound(round);
  const server = createWebServer({ db, cfg, now: () => at + 1000, liveIntervalMs: 20 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}/api/live`;
  const clients: WebSocket[] = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    server.emit('shutdown');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('WS 不得请求行情或回调本地HTTP接口'); });
  const socket = new WebSocket(url); clients.push(socket);
  const initial = await nextMessage(socket);
  assert.equal(initial.type, 'snapshot');
  assert.equal(typeof initial.revision, 'string');
  assert.equal(initial.pool.total, 1);
  assert.equal(initial.stats.dataQuality.collection.processed, 0);
  const progressMessage = nextMessage(socket);
  round.members[0]!.klineStatus = 'ready';
  runtime.saveCollectionRound(round);
  const progress = await progressMessage;
  assert.equal(progress.stats.dataQuality.collection.processed, 1);
  assert.notEqual(progress.revision, initial.revision);

  const scoreMessage = nextMessage(socket);
  const completed = { ...round, status: 'complete' as const, completedAt: at,
    members: [{ ...member, klineStatus: 'ready' as const, rpsScores: { ...emptyScores(), r16: 92 } }] };
  completed.coverage.r16 = { eligible: 100, available: 100, complete: true, source: 'kline' };
  runtime.saveRound(completed);
  const scored = await scoreMessage;
  assert.equal(scored.pool.items[0].displayRps.scores.r16, 92);
  assert.notEqual(scored.revision, progress.revision);

  socket.close(); await once(socket, 'close');
  const reconnect = new WebSocket(url); clients.push(reconnect);
  const restored = await nextMessage(reconnect);
  assert.equal(restored.pool.items[0].displayRps.scores.r16, 92);
  assert.equal(restored.revision, scored.revision);
});

test('WebSocket拒绝跨站升级，不提供客户端写入接口', async (t) => {
  const db = openDatabase(':memory:'); const cfg = loadStrategy(SAMPLE_STRATEGY);
  const server = createWebServer({ db, cfg, liveIntervalMs: 20 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.emit('shutdown'); await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); });
  const denied = new WebSocket(`ws://127.0.0.1:${address.port}/api/live`, { origin: 'https://different.example' });
  denied.on('error', () => {});
  const [, response] = await once(denied, 'unexpected-response');
  assert.equal(response.statusCode, 403);
  response.resume();
  denied.terminate();
  const allowed = new WebSocket(`ws://127.0.0.1:${address.port}/api/live`);
  await nextMessage(allowed);
  const closed = once(allowed, 'close');
  allowed.send('write');
  const [code] = await closed;
  assert.equal(code, 1008);
});

test('数据库变化后新客户端抢先连接，已有客户端也收到同一版本，不能等下一次数据变化', async (t) => {
  const db = openDatabase(':memory:'); const cfg = loadStrategy(SAMPLE_STRATEGY);
  const runtime = createRuntimeStore(db);
  const server = createWebServer({ db, cfg, now: () => at, liveIntervalMs: 10_000 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}/api/live`;
  const clients: WebSocket[] = [];
  t.after(async () => { for (const socket of clients) socket.terminate(); server.emit('shutdown');
    await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); });
  const first = new WebSocket(url); clients.push(first);
  const initial = await nextMessage(first);
  runtime.saveCollectionRound({ ...initialRound(cfg, at), boardComplete: true });
  const oldClientUpdate = nextMessage(first);
  const second = new WebSocket(url); clients.push(second);
  const [updated, joined] = await Promise.all([oldClientUpdate, nextMessage(second)]);
  assert.notEqual(updated.revision, initial.revision);
  assert.equal(updated.revision, joined.revision);
  assert.equal(updated.stats.dataQuality.collection.boardComplete, true);
});
