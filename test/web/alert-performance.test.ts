import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { loadStrategy } from '../../src/config/strategy.js';
import { INTERVAL_MS } from '../../src/market.js';
import { openDatabase } from '../../src/store/db.js';
import { createPoolStore } from '../../src/store/pool.js';
import { createSeriesStore } from '../../src/store/series.js';
import { createWebServer } from '../../src/web/server.js';
import { SAMPLE_STRATEGY, candle, poolItem } from '../helpers.js';

const quarter = INTERVAL_MS['15m'];
const fired = 1000 * quarter;          // 告警时刻
const now = fired + 96 * quarter;      // 一天后

const UP = '0x1111111111111111111111111111111111111111';
const DOWN = '0x2222222222222222222222222222222222222222';
const DEAD = '0x3333333333333333333333333333333333333333';

async function serve(t: TestContext) {
  const db = openDatabase(':memory:');
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  const pools = createPoolStore(db);
  const series = createSeriesStore(db);

  function seed(ca: string, entry: number, latest: number | null): void {
    pools.upsertPool([poolItem(ca, { chain: 'arc' })], fired);
    const identity = series.ensureSeries({ source: 'binance', scope: 'token', network: 'arc', ca,
      poolAddress: null, currency: 'usd', formatVersion: 1 }, fired);
    const bars = [candle(fired - quarter, entry)];
    if (latest !== null) bars.push(candle(now - quarter, latest));
    series.upsertCandles(identity.id, '15m', bars);
    series.activateSeries(identity.id, fired);
    db.prepare('INSERT INTO alerts (ca, tag, fired_at, payload, pushed) VALUES (?, ?, ?, ?, 1)')
      .run(ca, '30m_ath_pullback', fired, '{}');
  }
  seed(UP, 100, 150);      // +50%
  seed(DOWN, 100, 60);     // -40%
  seed(DEAD, 100, null);   // 告警后就没有新数据了

  const server = createWebServer({ db, cfg, now: () => now, liveIntervalMs: 20 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { server.emit('shutdown'); await new Promise<void>((r) => server.close(() => r())); db.close(); });
  return async (args: unknown) => (await (await globalThis.fetch(origin + '/api/agent/tool',
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alert_performance', arguments: args }) })).json()) as
    { result?: { items: Record<string, unknown>[]; summary: Record<string, unknown> }; error?: string };
}

test('给出某天告警的币，逐个对比告警时价格与最新价格', async (t) => {
  const post = await serve(t);
  const body = await post({ from: fired - quarter, to: fired + quarter });
  assert.ok(body.result, `应返回结果，实际 ${JSON.stringify(body)}`);

  const byCa = new Map(body.result!.items.map((row) => [row.ca as string, row]));
  assert.equal(byCa.size, 3);

  const up = byCa.get(UP)!;
  assert.equal(up.entryPrice, 100);
  assert.equal(up.currentPrice, 150);
  assert.ok(Math.abs((up.changePct as number) - 50) < 1e-6, `涨幅应为 50%，实际 ${up.changePct}`);

  const down = byCa.get(DOWN)!;
  assert.ok(Math.abs((down.changePct as number) + 40) < 1e-6, `跌幅应为 -40%，实际 ${down.changePct}`);
});

test('两端价格必须取自同一个序列，并说明价格的时间基准', async (t) => {
  const post = await serve(t);
  const row = (await post({ from: fired - quarter, to: fired + quarter })).result!.items
    .find((r) => r.ca === UP)!;
  assert.equal(row.source, 'binance', '要说明价格来自哪个源');
  assert.ok(typeof row.priceAsOf === 'number' && (row.priceAsOf as number) > 0,
    '必须给出最新价的时间，否则无法判断这个价格有多旧');
});

test('告警后就没有新数据的币要标出来，不能当成零涨跌', async (t) => {
  const post = await serve(t);
  const row = (await post({ from: fired - quarter, to: fired + quarter })).result!.items
    .find((r) => r.ca === DEAD)!;
  assert.equal(row.changePct, null, '拿不到最新价时不能编一个 0');
  assert.ok(typeof row.unavailable === 'string', '要说明为什么没有数值');
});

test('汇总给出涨跌各多少，以及有多少个算不出来', async (t) => {
  const post = await serve(t);
  const summary = (await post({ from: fired - quarter, to: fired + quarter })).result!.summary;
  assert.equal(summary.total, 3);
  assert.equal(summary.up, 1);
  assert.equal(summary.down, 1);
  assert.equal(summary.unavailable, 1);
});

test('时间窗之外的告警不算进来', async (t) => {
  const post = await serve(t);
  const body = await post({ from: fired + 10 * quarter, to: fired + 20 * quarter });
  assert.equal(body.result!.items.length, 0);
  assert.equal(body.result!.summary.total, 0);
});
