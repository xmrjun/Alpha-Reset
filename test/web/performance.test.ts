import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { loadStrategy } from '../../src/config/strategy.js';
import { emptyScores, INTERVAL_MS } from '../../src/market.js';
import { openDatabase } from '../../src/store/db.js';
import { createPoolStore } from '../../src/store/pool.js';
import { createRuntimeStore, initialRound, pendingMember } from '../../src/store/runtime.js';
import { createSeriesStore } from '../../src/store/series.js';
import { createWebReadModel } from '../../src/web/read-context.js';
import { createWebServer } from '../../src/web/server.js';
import { SAMPLE_STRATEGY, candle, poolItem } from '../helpers.js';

const httpFetch = globalThis.fetch;
const Q = INTERVAL_MS['15m'];
const at = 1000 * Q;
const sqlHistory = (sql: string) => /SELECT\s+open_time\s+AS\s+openTime/i.test(sql) && /FROM\s+(?:series_candles|candles)\b/i.test(sql);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-web-read-'));
  const filename = join(dir, 'data.sqlite');
  const writer = openDatabase(filename); const cfg = loadStrategy(SAMPLE_STRATEGY);
  const pool = createPoolStore(writer); const series = createSeriesStore(writer);
  const runtime = createRuntimeStore(writer, () => at + 1234);
  const members = ['a', 'b'].map(ca => {
    pool.upsertPool([poolItem(ca, { chain: 'solana' })], at);
    const identity = series.ensureSeries({ source: 'geckoterminal', network: 'solana', ca, poolAddress: 'pool-' + ca,
      currency: 'usd', formatVersion: 1 }, at);
    series.upsertCandles(identity.id, '15m', Array.from({ length: 300 }, (_, i) => candle(at - (300 - i) * Q, 10 + i)));
    series.activateSeries(identity.id, at);
    return { ...pendingMember(pool.getPoolItem(ca)!, 1), seriesId: identity.id, klineStatus: 'ready' as const,
      rpsScores: { ...emptyScores(), r16: 92 }, result: { passed: true,
        reasons: { a1: true, a2: true, a3: true, a4: true }, tags: ['low_vol_30m' as const], newMoments: [] } };
  });
  const round = { ...initialRound(cfg, at), completedAt: at + 1001, status: 'complete' as const,
    boardComplete: true, sourceCount: 2, members };
  runtime.saveRound(round); runtime.saveObservationRound(round); runtime.saveCollectionRound(round, false);
  const queries: string[] = [];
  const reader = new Database(filename, { readonly: true, verbose: sql => queries.push(String(sql)) });
  return { dir, writer, reader, cfg, series, runtime, members, round, queries,
    close: () => { reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function nextMessage(socket: WebSocket) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([
    once(socket, 'message').then(([data]) => JSON.parse(data.toString())),
    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('WS update timeout')), 3000); }),
  ]); } finally { if (timeout) clearTimeout(timeout); }
}

test('列表/统计/WS不读取历史OHLC，外部同毫秒写入即时推送，过期只保留带时间的展示值', async t => {
  const f = fixture(); let now = at + 2000;
  const historyBindings: { sql: string; params: unknown[] }[] = [];
  const statementPrototype = Object.getPrototypeOf(f.reader.prepare('SELECT 1')) as Database.Statement;
  const originalAll = statementPrototype.all;
  // SQLite verbose truncates long bound strings (including 64-character series IDs).
  // Capture the actual arguments as well, so identity assertions use the complete ID.
  t.mock.method(statementPrototype, 'all', function (this: Database.Statement, ...params: unknown[]) {
    if (this.database === f.reader && sqlHistory(this.source)) historyBindings.push({ sql: this.source, params });
    return originalAll.apply(this, params);
  });
  const server = createWebServer({ db: f.reader, cfg: f.cfg, now: () => now, liveIntervalMs: 20 });
  const sockets: WebSocket[] = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); server.emit('shutdown');
    await new Promise<void>(resolve => server.close(() => resolve())); f.close(); });
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Web 不得访问上游'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const get = async (path: string) => { const response = await httpFetch(origin + path); assert.equal(response.status, 200); return response.json(); };
  f.queries.length = 0;
  const pool = await get('/api/pool'); const stats = await get('/api/stats');
  assert.equal(pool.items[0].rpsScores.r16, 92); assert.deepEqual(pool.items[0].tags, ['low_vol_30m']);
  assert.equal(stats.dataQuality.freshPriceCount, 2);
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/live'); sockets.push(socket);
  const first = await nextMessage(socket);
  assert.equal(first.pool.total, 2);
  assert.deepEqual(f.queries.filter(sqlHistory), [], '列表/统计/WS只做索引端点存在查询，不读取整池OHLC');
  const changed = nextMessage(socket);
  const sameTime = f.writer.prepare("SELECT updated_at FROM runtime_state WHERE key='last_round'").get();
  f.round.members[0]!.rpsScores.r16 = 81;
  f.runtime.saveRound(f.round);
  assert.deepEqual(f.writer.prepare("SELECT updated_at FROM runtime_state WHERE key='last_round'").get(), sameTime);
  const revised = await changed;
  assert.equal(revised.pool.items.find((row: { ca: string }) => row.ca === 'a').rpsScores.r16, 81);
  assert.notEqual(revised.revision, first.revision);
  const expires = nextMessage(socket);
  now = f.round.completedAt + f.cfg.schedule.mainLoopMinutes * 60_000;
  const stale = await expires;
  const row = stale.pool.items.find((item: { ca: string }) => item.ca === 'a');
  assert.deepEqual(row.rpsScores, emptyScores()); assert.deepEqual(row.tags, []);
  assert.equal(row.displayRps.scores.r16, 81); assert.equal(row.displayRps.state, 'stale');
  assert.equal(row.displayRps.asOf, at);
  assert.deepEqual(f.queries.filter(sqlHistory), []);
  socket.close(); await once(socket, 'close');
  f.queries.length = 0; historyBindings.length = 0;
  const detail = await get('/api/ca/a?interval=30m&limit=5');
  assert.equal(detail.candles.length, 5);
  const historical = f.queries.filter(sqlHistory);
  assert.ok(historical.length > 0, '详情仍读取目标资产历史');
  assert.equal(historyBindings.length, historical.length, '每条实际历史查询都必须记录原始绑定参数');
  assert.ok(historyBindings.every(({ sql }) => /FROM\s+series_candles\b/i.test(sql)), '已绑定资产不能回退读取legacy历史');
  assert.ok(historyBindings.every(({ params }) => params[0] === f.members[0]!.seriesId), '详情只查询完整匹配的目标seriesId');
  assert.ok(historyBindings.every(({ params }) => !params.includes(f.members[1]!.seriesId)), '详情不能扫描另一资产历史');
});

test('Web专属解析缓存复用未变对象，普通历史写入不改版本，身份/名单/端点变化和过期边界不遗漏', t => {
  const f = fixture(); t.after(f.close);
  const reads = createWebReadModel(f.reader, f.cfg);
  const read = () => f.reader.transaction(() => reads.readContext())();
  const version = (now = at + 2000) => f.reader.transaction(() => reads.readVersion(now))();
  const initial = version(); const first = read().runtime.getRound();
  assert.ok(first); assert.equal(read().runtime.getRound(), first, '相同payload只校验一次并复用只读对象');
  const mutable = f.runtime.getRound()!; mutable.members[0]!.rpsScores.r16 = 1;
  assert.equal(f.runtime.getRound()!.members[0]!.rpsScores.r16, 92, '默认调度读取不共享可变对象');
  assert.equal(read().runtime.getRound()!.members[0]!.rpsScores.r16, 92);
  f.series.upsertCandles(f.members[0]!.seriesId, '15m', [candle(at - 100 * Q, 123)]);
  assert.equal(version(), initial, '外部连接写入无关历史，不触发Web快照重建');
  assert.equal(read().runtime.getRound(), first);
  f.writer.prepare("DELETE FROM series_candles WHERE series_id=? AND interval='15m' AND open_time=?").run(f.members[0]!.seriesId, at-Q);
  assert.notEqual(version(), initial, '固定端点存在位变化必须可见');
  assert.equal(read().hasEndpoint(f.members[0]!, at-Q), false);
  const beforeIdentity = version();
  f.writer.prepare('UPDATE market_series SET active=0 WHERE id=?').run(f.members[0]!.seriesId);
  assert.notEqual(version(), beforeIdentity); assert.equal(read().series.getActive('solana', 'a'), null);
  const beforeList = version();
  f.runtime.saveObservationRound({ ...f.round, sourceCount: 1, members: [f.members[1]!] });
  assert.notEqual(version(), beforeList); assert.equal(read().runtime.getObservationRound()!.members.length, 1);
  const deadline = f.round.completedAt + f.cfg.schedule.mainLoopMinutes * 60_000;
  assert.equal(Math.floor((deadline-1)/15000), Math.floor(deadline/15000), '夹具刻意在同一15秒桶内跨过期线');
  assert.notEqual(version(deadline-1), version(deadline), '没有DB写入也必须准确更新过期状态');
  assert.deepEqual(f.queries.filter(sqlHistory), []);
});
