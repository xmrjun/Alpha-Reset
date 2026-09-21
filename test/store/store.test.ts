import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { openDatabase } from '../../src/store/db.js';
import { createCandleStore } from '../../src/store/candles.js';
import { createPoolStore } from '../../src/store/pool.js';
import { createAlertStore } from '../../src/store/alerts.js';
import { createMomentStore } from '../../src/store/moments.js';
import { createUsageStore } from '../../src/store/usage.js';
import { candle, poolItem } from '../helpers.js';

function database(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'alpha-store-'));
  const filename = join(directory, 'nested', 'test.sqlite');
  const db = openDatabase(filename);
  t.after(() => { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, filename };
}

test('数据库建表、索引、WAL 与迁移幂等，重启后保留数据', (t) => {
  const { db, filename } = database(t);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('user_version', { simple: true }), 7);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name")
    .all() as { name: string }[];
  assert.deepEqual(tables.map((row) => row.name), ['agent_tool_calls', 'alert_outcomes', 'alert_social', 'alerts', 'api_usage', 'breakout_moments', 'ca_pool', 'candles', 'group_ca_history', 'market_series', 'market_series_switches', 'runtime_state', 'series_candles', 'series_moments']);
  const indices = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'idx_%' ORDER BY name")
    .all() as { name: string }[];
  assert.deepEqual(indices.map((row) => row.name), ['idx_agent_tool_calls_quota', 'idx_agent_tool_calls_visitor',
    'idx_alert_social_done', 'idx_alert_social_pending', 'idx_alerts_ca_tag_t', 'idx_candles_ca_iv_t', 'idx_history_group', 'idx_history_mention', 'idx_market_series_active', 'idx_market_series_token', 'idx_outcomes_group', 'idx_outcomes_pending', 'idx_series_candles_t', 'idx_series_switches_asset']);
  createCandleStore(db).upsertCandles('a', '15m', [candle(0)]);
  db.close();
  const reopened = openDatabase(filename);
  try {
    assert.deepEqual(createCandleStore(reopened).getCandles('a', '15m'), [candle(0)]);
  } finally { reopened.close(); }
});

test('拒绝打开更高版本数据库', (t) => {
  const { db, filename } = database(t);
  db.pragma('user_version = 8');
  db.close();
  assert.throws(() => openDatabase(filename), /数据库版本/);
});

test('K 线重复 upsert 幂等、更新同根、保留全部历史并按 CA/周期隔离', (t) => {
  const { db } = database(t);
  const store = createCandleStore(db);
  const bars = [candle(0), candle(900_000), candle(1_800_000)];
  store.upsertCandles('a', '15m', bars);
  store.upsertCandles('a', '15m', bars);
  store.upsertCandles('a', '15m', [candle(1_800_000, 20), candle(2_700_000)]);
  store.upsertCandles('b', '15m', [candle(0, 30)]);
  store.upsertCandles('a', '1h', [candle(0, 40)]);
  assert.deepEqual(store.getCandles('a', '15m'), [candle(2_700_000), candle(1_800_000, 20),
    candle(900_000), candle(0)]);
  assert.deepEqual(store.getCandles('a', '15m', 2), [candle(2_700_000), candle(1_800_000, 20)]);
  assert.deepEqual(store.getCandles('a', '1h'), [candle(0, 40)]);
  assert.deepEqual(store.getCandles('b', '15m'), [candle(0, 30)]);
  assert.deepEqual(store.getCandles('missing', '15m'), []);
  assert.deepEqual(store.getCandles('a', '15m', 0), []);
  assert.throws(() => store.getCandles('a', '15m', -1), RangeError);
});

test('K 线批次失败全部回滚，空批次无副作用', (t) => {
  const store = createCandleStore(database(t).db);
  store.upsertCandles('a', '15m', [candle(0)]);
  assert.throws(() => store.upsertCandles('a', '15m', [candle(0, 20), candle(900_000, NaN)]));
  store.upsertCandles('a', '15m', []);
  assert.deepEqual(store.getCandles('a', '15m'), [candle(0)]);
});

test('观察池更新保留 firstSeenAt/上市时间，不用提及时间代替上市时间', (t) => {
  const store = createPoolStore(database(t).db);
  store.upsertPool([poolItem('a', { latestMentionTime: 10 })], 100);
  assert.equal(store.getPoolItem('a')!.listedAt, null);
  store.upsertPool([{ ...poolItem('a'), listedAt: 50, tokenName: 'Name' }], 200);
  store.upsertPool([poolItem('a', { marketCap: 200_000 })], 300);
  store.upsertPool([poolItem('a', { marketCap: 10 })], 150);
  assert.deepEqual(store.getPoolItem('a'), { ...poolItem('a', { marketCap: 200_000 }),
    firstSeenAt: 100, listedAt: 50, tokenName: 'Name', updatedAt: 300 });
  assert.equal(store.getPool().length, 1);
  assert.equal(store.getPoolItem('missing'), null);
});

test('告警冷却只计算成功推送，精确边界可再推，不受未来记录影响', (t) => {
  const store = createAlertStore(database(t).db);
  const tag = '30m_ath_pullback';
  const id = store.recordAlert({ ca: 'a', tag, firedAt: 100, payload: { rsi: 55 } });
  assert.equal(store.isInCooldown('a', tag, 150, 100), false);
  store.markPushed([id]);
  assert.equal(store.isInCooldown('a', tag, 100, 100), true);
  assert.equal(store.isInCooldown('a', tag, 199, 100), true);
  assert.equal(store.isInCooldown('a', tag, 200, 100), false);
  assert.equal(store.isInCooldown('a', tag, 99, 100), false);
  assert.equal(store.isInCooldown('a', tag, 100, 0), false);
  assert.equal(store.isInCooldown('b', tag, 150, 100), false);
  assert.equal(store.isInCooldown('a', 'low_vol_30m', 150, 100), false);
  assert.throws(() => store.isInCooldown('a', tag, 150, -1), RangeError);
});

test('告警保存 JSON 快照，筛选、倒序和 total 不受 limit 影响', (t) => {
  const store = createAlertStore(database(t).db);
  const payload = { reasons: { a1: true }, tags: ['low_vol_30m'], score: null };
  store.recordAlert({ ca: 'a', tag: 'low_vol_30m', firedAt: 100, payload, pushed: true });
  store.recordAlert({ ca: 'a', tag: 'low_vol_30m', firedAt: 200, payload });
  store.recordAlert({ ca: 'b', tag: 'low_vol_4h', firedAt: 300, payload: null });
  const result = store.getAlerts({ ca: 'a', tag: 'low_vol_30m', from: 100, to: 200, limit: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.firedAt, 200);
  assert.deepEqual(result.items[0]!.payload, payload);
  assert.equal(result.items[0]!.pushed, false);
  assert.deepEqual(store.getAlerts({ ca: 'missing' }), { items: [], total: 0 });
  assert.equal(store.getAlerts({ limit: 0 }).total, 3);
  assert.throws(() => store.getAlerts({ limit: -1 }), RangeError);
  assert.throws(() => store.recordAlert({ ca: 'a', tag: 'low_vol_30m', firedAt: 1, payload: undefined }));
});

test('新高时刻按 CA/编号保存，重放旧记录不回退，不重复刷新 detected_at', (t) => {
  const { db } = database(t);
  const store = createMomentStore(db);
  store.upsertMoments('a', [{ moment: 1, barTime: 100, price: 10 }, { moment: 2, barTime: 100, price: 10 }], 200);
  store.upsertMoments('a', [{ moment: 1, barTime: 100, price: 10 }], 300);
  assert.equal((db.prepare('SELECT detected_at FROM breakout_moments WHERE ca = ? AND moment = 1')
    .get('a') as { detected_at: number }).detected_at, 200);
  store.upsertMoments('a', [{ moment: 1, barTime: 200, price: 20 }], 400);
  store.upsertMoments('a', [{ moment: 1, barTime: 100, price: 10 }], 500);
  store.upsertMoments('b', [{ moment: 1, barTime: 50, price: 5 }], 100);
  assert.deepEqual(store.getMoments('a'), [{ moment: 1, barTime: 200, price: 20 }, { moment: 2, barTime: 100, price: 10 }]);
  assert.deepEqual(store.getMoments('missing'), []);
});

test('配额逐次计数、按日隔离，服务端同步不回退本地用量', (t) => {
  const store = createUsageStore(database(t).db);
  assert.equal(store.getUsage('2026-09-11'), null);
  store.incrementUsage('2026-09-11', 100);
  store.incrementUsage('2026-09-11', 200);
  assert.equal(store.getUsage('2026-09-11')!.calls, 2);
  store.syncUsage('2026-09-11', 100, 300);
  store.syncUsage('2026-09-11', 50, 250);
  store.incrementUsage('2026-09-12', 400);
  assert.deepEqual(store.getUsage('2026-09-11'), { date: '2026-09-11', calls: 100, updatedAt: 300 });
  assert.equal(store.getUsage('2026-09-12')!.calls, 1);
  assert.throws(() => store.syncUsage('2026-09-12', -1, 500), RangeError);
});
