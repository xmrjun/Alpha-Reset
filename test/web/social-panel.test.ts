import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { loadStrategy } from '../../src/config/strategy.js';
import { createAlertSocialStore } from '../../src/store/alert-social.js';
import { openDatabase } from '../../src/store/db.js';
import { createSeriesStore } from '../../src/store/series.js';
import { createWebServer } from '../../src/web/server.js';
import { SAMPLE_STRATEGY } from '../helpers.js';

const quarter = 900_000;
const fired = 1_000_000 * quarter;
const now = fired + 8 * quarter;

function quality(verdict: 'manufactured' | 'organic') {
  return { total: 10, organic: 2, manufactured: verdict === 'manufactured' ? 8 : 1,
    botRatio: verdict === 'manufactured' ? 0.8 : 0.1, clusters: 1, medianViews: 76,
    kols: verdict === 'organic' ? ['big_voice'] : [], mentions: [], verdict, posts: [] } as const;
}

async function boot(t: TestContext, seeds: [string, 'manufactured' | 'organic', number | null][]) {
  const db = openDatabase(':memory:');
  const social = createAlertSocialStore(db);
  const series = createSeriesStore(db);
  const outcome = db.prepare(`INSERT INTO alert_outcomes (ca, baseline_at, horizon_hours, alerted, tags,
    series_id, entry_price, exit_price, return_pct, settled_at, recorded_at) VALUES (?,?,?,1,'',?,1,1,?,?,?)`);

  for (const [ca, verdict, ret] of seeds) {
    social.queue({ ca, firedAt: fired, symbol: ca.slice(2, 8), chain: 'arc' }, fired);
    social.record(ca, fired, quality(verdict), fired + quarter);
    if (ret !== null) {
      // alert_outcomes.series_id 有外键，必须指向真实存在的序列
      const identity = series.ensureSeries({ source: 'binance', scope: 'token', network: 'arc', ca,
        poolAddress: null, currency: 'usd', formatVersion: 1 }, fired);
      outcome.run(ca, fired, 24, identity.id, ret, now, fired);
    }
  }

  const server = createWebServer({ db, cfg: loadStrategy(SAMPLE_STRATEGY), now: () => now, liveIntervalMs: 20 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { server.emit('shutdown'); await new Promise<void>((r) => server.close(() => r())); db.close(); });
  return (await (await globalThis.fetch(origin + '/api/social?limit=20')).json()) as {
    summary: Record<string, number>;
    comparison: { verdict: string; n: number; medianReturnPct: number | null }[];
    items: Record<string, unknown>[];
  };
}

const withReturns: [string, 'manufactured' | 'organic', number | null][] = [
  ['0xaaa1000000000000000000000000000000000001', 'manufactured', -40],
  ['0xaaa2000000000000000000000000000000000002', 'manufactured', -20],
  ['0xbbb1000000000000000000000000000000000003', 'organic', 30],
];

test('面板给出逐条判定', async (t) => {
  const body = await boot(t, withReturns);
  assert.equal(body.items.length, 3);
  const first = body.items[0]!;
  for (const field of ['verdict', 'botRatio', 'symbol', 'total', 'medianViews']) {
    assert.ok(field in first, `单条应含 ${field}`);
  }
});

test('汇总按判定分组', async (t) => {
  const body = await boot(t, withReturns);
  assert.equal(body.summary.checked, 3);
  assert.equal(body.summary.manufactured, 2);
  assert.equal(body.summary.organic, 1);
});

test('把社交判定和事后收益对照起来 —— 这才是做这件事的目的', async (t) => {
  const body = await boot(t, withReturns);
  const made = body.comparison.find((row) => row.verdict === 'manufactured');
  const real = body.comparison.find((row) => row.verdict === 'organic');
  assert.equal(made?.n, 2);
  assert.equal(made?.medianReturnPct, -30, '-40 与 -20 的中位数是 -30');
  assert.equal(real?.n, 1);
  assert.equal(real?.medianReturnPct, 30);
});

test('还没有事后收益时不硬凑对照，返回空而不是编一个 0', async (t) => {
  const body = await boot(t, [['0xccc1000000000000000000000000000000000004', 'organic', null]]);
  assert.deepEqual(body.comparison, []);
  assert.equal(body.items.length, 1);
});
