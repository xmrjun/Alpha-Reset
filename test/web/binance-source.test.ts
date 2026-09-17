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

const quarter = INTERVAL_MS['15m'];
const at = 1000 * quarter;
const next = at + 2 * quarter;

function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  cfg.kline.gmgn.enabled = true;
  cfg.kline.binance = { enabled: true, requestsPerMinute: 180, refreshMinutes: 2, historyDays: 10,
    chains: ['robinhood', 'bsc', 'solana', 'base', 'ethereum', 'avalanche'] };
  const runtime = createRuntimeStore(db);
  const pools = createPoolStore(db);
  const series = createSeriesStore(db);
  function member(ca: string, source: 'gmgn' | 'binance' | 'geckoterminal' | null, network = 'solana'): RoundMember {
    pools.upsertPool([poolItem(ca, { chain: network })], at);
    const pending = { ...pendingMember(pools.getPoolItem(ca)!, 1), seriesId: null };
    if (!source) return pending;
    const identity = series.ensureSeries(source === 'geckoterminal'
      ? { source, network, ca, poolAddress: 'pool-' + ca, currency: 'usd', formatVersion: 1 }
      : { source, scope: 'token', network, ca, poolAddress: null, currency: 'usd', formatVersion: 1 }, at);
    series.upsertCandles(identity.id, '15m', [candle(at - quarter, 10), candle(next - quarter, 20)]);
    series.activateSeries(identity.id, at);
    return { ...pending, seriesId: identity.id, klineStatus: 'ready', rpsScores: { ...emptyScores(), r16: 92 },
      result: { passed: true, reasons: { a1: true, a2: true, a3: true, a4: true }, tags: ['low_vol_30m'], newMoments: [] } };
  }
  const completed = (members: RoundMember[], startedAt = at) => ({ ...initialRound(cfg, startedAt), members,
    sourceCount: members.length, boardComplete: true, status: 'complete' as const, completedAt: startedAt });
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Web 只读本地数据，不得请求行情'); });
  return { db, cfg, runtime, pools, series, member, completed };
}

const httpFetch = globalThis.fetch;
async function serve(t: TestContext, f: ReturnType<typeof fixture>) {
  const server = createWebServer({ db: f.db, cfg: f.cfg, now: () => next + 1000, liveIntervalMs: 20 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { server.emit('shutdown'); await new Promise<void>((resolve) => server.close(() => resolve())); f.db.close(); });
  return { get: async (path: string) => {
    const response = await httpFetch(origin + path);
    assert.equal(response.status, 200);
    return response.json() as Promise<any>;
  } };
}

test('binance 来源的成员计入 binance，不得被误报成未绑定', async (t) => {
  const f = fixture(t);
  const members = [f.member('bnb-one', 'binance'), f.member('bnb-two', 'binance', 'bsc'),
    f.member('gmgn-one', 'gmgn'), f.member('gecko-one', 'geckoterminal', 'bsc'), f.member('none', null)];
  const round = f.completed(members, next);
  f.runtime.saveRound(round);
  f.runtime.saveObservationRound(round);

  const { get } = await serve(t, f);
  const stats = await get('/api/stats');

  assert.deepEqual(stats.dataQuality.calculation.sources,
    { gmgn: 1, geckoterminal: 1, binance: 2, unbound: 1 },
    'binance 必须单独计数；算进 unbound 会让页面谎报“无行情源”');

  assert.ok(stats.dataQuality.enabledSources.includes('binance'),
    '启用了 binance 就必须出现在数据源清单里，否则页脚会漏标注一个正在承担多数成员的来源');
});

test('Gecko 采集范围排除所有 token 源成员，不把别家的工作量算进自己的扫描耗时', async (t) => {
  const f = fixture(t);
  // gecko-one 是唯一真正由 Gecko 承担的；两个 binance、一个 gmgn 都不该计入，
  // 未绑定的 none 所在链已由 binance 覆盖，也不该排进 Gecko 队列。
  const members = [f.member('bnb-one', 'binance'), f.member('bnb-two', 'binance', 'bsc'),
    f.member('gmgn-one', 'gmgn'), f.member('gecko-one', 'geckoterminal', 'bsc'), f.member('none', null)];
  const round = f.completed(members, next);
  f.runtime.saveRound(round);
  f.runtime.saveObservationRound(round);
  f.runtime.saveCollectionRound({ ...round, status: 'running', completedAt: null }, false);

  const { get } = await serve(t, f);
  const stats = await get('/api/stats');

  assert.equal(stats.dataQuality.collection.memberCount, 1,
    'binance 承担的成员被算进 Gecko 范围会让页面谎报扫描耗时');
});

test('binance 序列的 scoreSource 如实上报，不退化成 null', async (t) => {
  const f = fixture(t);
  const members = [f.member('bnb-one', 'binance'), f.member('gecko-one', 'geckoterminal', 'bsc')];
  const round = f.completed(members, next);
  f.runtime.saveRound(round);
  f.runtime.saveObservationRound(round);

  const { get } = await serve(t, f);
  const pool = await get('/api/pool');
  const row = pool.items.find((item: any) => item.ca === 'bnb-one');

  assert.ok(row, '池子里应有该成员');
  assert.equal(row.scoreSource, 'binance', 'binance 序列的 scoreSource 不能是 null');
});

test('binance 采集器状态与 gmgn 对等暴露，页面才能看见主力源在做什么', async (t) => {
  const f = fixture(t);
  const round = f.completed([f.member('bnb-one', 'binance')], next);
  f.runtime.saveRound(round);
  f.runtime.saveObservationRound(round);
  const status = { status: 'running', updatedAt: next, requests: 41, recentRequests: 37,
    historyRequests: 4, assetsWithHistory: 3, backfillPending: 1, cooldownUntil: 0,
    lastErrorCode: 'PRIVATE_SENTINEL', apiKey: 'PRIVATE_SENTINEL' };
  f.db.prepare('INSERT INTO runtime_state(key,payload,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at')
    .run('binance_status', JSON.stringify(status), next);

  const { get } = await serve(t, f);
  const q = (await get('/api/stats')).dataQuality;

  assert.equal(q.binance.enabled, true);
  assert.equal(q.binance.status, 'running');
  assert.equal(q.binance.requests, 41);
  assert.equal(q.binance.assetsWithHistory, 3);
  assert.equal(q.binance.backfillPending, 1);
  assert.equal(q.binance.effectiveRpm, f.cfg.kline.binance.requestsPerMinute);
  assert.ok(!JSON.stringify(q.binance).includes('PRIVATE_SENTINEL'),
    '运行状态只发布白名单字段，错误码与凭据不得外泄');
});
