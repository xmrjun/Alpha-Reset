import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { loadStrategy } from '../../src/config/strategy.js';
import { aggregateCandles } from '../../src/indicators/merge.js';
import { INTERVAL_MS } from '../../src/market.js';
import type { Notification } from '../../src/notify/telegram.js';
import { createScheduler } from '../../src/scheduler/main.js';
import { createQuotaGuard } from '../../src/scheduler/quota.js';
import { openDatabase } from '../../src/store/db.js';
import { createPoolStore } from '../../src/store/pool.js';
import { createRuntimeStore, initialRound, pendingMember } from '../../src/store/runtime.js';
import { createSeriesStore, type MarketSeries, type TokenSource } from '../../src/store/series.js';
import type { Candle, DexSnapshot } from '../../src/types.js';
import { candle, poolItem, SAMPLE_STRATEGY } from '../helpers.js';

const T = 100 * INTERVAL_MS['1d'];
const STEP = INTERVAL_MS['15m'];
const SLOT = 30 * 60_000;

function history(until = T, count = 800, start = 100): Candle[] {
  return Array.from({ length: count }, (_, i) => candle(until - (count - i) * STEP, start + i));
}

function fixture(t: TestContext, chain = 'solana') {
  const db = openDatabase(':memory:');
  t.after(() => { if (db.open) db.close(); });
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  cfg.kline.gmgn.enabled = true;
  cfg.kline.gmgn.chains = ['sol', 'bsc', 'base', 'eth', 'robinhood'];
  cfg.kline.binance = { enabled: true, requestsPerMinute: 120, refreshMinutes: 1, historyDays: 8,
    chains: ['robinhood', 'bsc', 'solana', 'base', 'ethereum', 'avalanche'] };

  let now = T;
  const clock = () => now;
  const state = createRuntimeStore(db, clock);
  const series = createSeriesStore(db);
  const pool = createPoolStore(db);
  const quota = createQuotaGuard(db, cfg, clock);
  const notifications: Notification[] = [];
  const ca = 'a';

  const round = initialRound(cfg, T);
  round.boardComplete = true; round.status = 'complete'; round.completedAt = T;
  pool.upsertPool([poolItem(ca, { chain })], T);
  const listedAt = T - 60 * INTERVAL_MS['1d'];
  state.cacheListing(ca, listedAt, chain);
  const member = pendingMember({ ...pool.getPoolItem(ca)!, listedAt }, 1);
  const dex: DexSnapshot = { pairAddress: 'pool-' + ca, chainId: chain, priceUsd: 100,
    marketCap: 100_000, liquidityUsd: 50_000, pairCreatedAt: listedAt,
    priceChange: { m5: null, h1: null, h6: null, h24: null } };
  member.dex = dex; member.dexAt = T; member.dexStatus = 'ok'; member.seriesId = null;
  round.members.push(member);
  state.saveObservationRound(round);

  const make = () => createScheduler({ db, cfg, quota, clock, log: () => {},
    notifier: { async notify(value) { notifications.push(value); return { tags: value.tags, messages: 0 }; } },
    client: {
      async getTokenUsage() { return { usedToday: 0, remainingToday: 10_000, dailyLimit: 10_000 }; },
      async getBoardSummary() { return []; },
      async getKline() { return assert.fail('本测试不得访问二娃 K 线'); },
      async getDexScreener() { return assert.fail('本地计算不得发 Dex HTTP'); },
    },
    klineSource: { async getCandles15m() { return history(now); } },
  });

  function write(identity: MarketSeries, bars: Candle[]) {
    series.upsertCandles(identity.id, '15m', bars);
    series.upsertCandles(identity.id, '1h', aggregateCandles(bars, STEP, INTERVAL_MS['1h']));
    series.upsertCandles(identity.id, '4h', aggregateCandles(bars, STEP, INTERVAL_MS['4h']));
  }
  function add(source: 'geckoterminal' | TokenSource, bars = history(), active = false) {
    const common = { network: chain, ca, currency: 'usd' as const, formatVersion: 1 };
    const identity = source === 'geckoterminal'
      ? series.ensureSeries({ ...common, source, poolAddress: 'pool-' + ca }, now)
      : series.ensureSeries({ ...common, source, scope: 'token' as const, poolAddress: null }, now);
    write(identity, bars);
    return active ? series.activateSeries(identity.id, now) : identity;
  }
  return { db, cfg, state, series, notifications, make, add, write, setNow(value: number) { now = value; } };
}

test('活跃来源已是 GMGN 时，达标的 Binance 候选在下一个 T 受控接管', async (t) => {
  const f = fixture(t);
  const gmgn = f.add('gmgn', history(T), true);
  const scheduler = f.make();

  await scheduler.calculateAt(T);
  assert.equal(f.state.getRound()!.members[0]!.seriesId, gmgn.id, '同 T 内不得换源');

  f.setNow(T + SLOT + 5_000);
  const binance = f.add('binance', history(T + SLOT, 800, 1000));
  f.write(binance, history(T + SLOT, 800, 1000));

  assert.ok(await scheduler.calculateAt(T + SLOT));
  const switched = f.state.getRound()!;
  assert.equal(switched.members[0]!.plannedSource, 'binance');
  assert.equal(switched.members[0]!.seriesId, binance.id);
  assert.equal(f.series.getActive( 'solana', 'a')!.id, binance.id);
  assert.equal(f.series.getSeries(gmgn.id)!.active, false, '旧 GMGN 序列应让出 active');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM market_series_switches').get() as { n: number }).n, 1,
    '换源必须留下可审计记录');
});

test('Binance 候选历史不足时不得撤下可用的 GMGN', async (t) => {
  const f = fixture(t);
  const gmgn = f.add('gmgn', history(T), true);
  f.add('binance', history(T, 20, 1000));
  const scheduler = f.make();

  await scheduler.calculateAt(T);

  assert.equal(f.series.getActive('solana', 'a')!.id, gmgn.id, '历史不足不得换源');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM market_series_switches').get() as { n: number }).n, 0);
});

test('binance 不支持的链保持原有 Gecko 路径，不产生 token 候选偏好', async (t) => {
  const f = fixture(t, 'arc');
  const gecko = f.add('geckoterminal', history(T), true);
  const scheduler = f.make();

  await scheduler.calculateAt(T);

  assert.equal(f.state.getRound()!.members[0]!.seriesId, gecko.id);
  assert.equal(f.state.getRound()!.members[0]!.plannedSource, 'geckoterminal');
});

test('成熟的 Binance 候选在新 T 先预定，当期端点迟到后于同一 T 内完成接管', async (t) => {
  const f = fixture(t);
  const gmgn = f.add('gmgn', history(T), true);
  const scheduler = f.make();
  await scheduler.calculateAt(T);
  assert.equal(f.state.getRound()!.members[0]!.seriesId, gmgn.id);

  // 新 T：候选历史已成熟，但整点那根端点还没到（线上每个整点的常态）。
  f.setNow(T + SLOT);
  const candidate = f.add('binance', history(T + SLOT - STEP, 800, 1000));
  assert.ok(await scheduler.calculateAt(T + SLOT));
  const waiting = f.state.getRound()!.members[0]!;
  assert.equal(waiting.plannedSource, 'binance', '成熟候选必须在新 T 先预定，否则同 T 内再无机会');
  assert.equal(waiting.seriesId, null, '预定期间不绑定序列');
  assert.equal(f.series.getActive('solana', 'a')!.id, gmgn.id, '未就绪前不得改动活跃源');

  // 同一个 T 内端点到达，完成接管。
  f.setNow(T + SLOT + 10_000);
  f.write(candidate, history(T + SLOT, 800, 1000));
  assert.ok(await scheduler.calculateAt(T + SLOT));
  assert.equal(f.state.getRound()!.members[0]!.seriesId, candidate.id, '端点到齐后应绑定 Binance');
  assert.equal(f.series.getActive('solana', 'a')!.id, candidate.id);
});
