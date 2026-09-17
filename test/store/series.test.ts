import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { loadStrategy } from '../../src/config/strategy.js';
import { emptyBounds } from '../../src/indicators/observation-rps.js';
import { createAlertStore } from '../../src/store/alerts.js';
import { createCandleStore } from '../../src/store/candles.js';
import { openDatabase } from '../../src/store/db.js';
import { createMomentStore } from '../../src/store/moments.js';
import { createPoolStore } from '../../src/store/pool.js';
import { createRuntimeStore, initialRound, pendingMember } from '../../src/store/runtime.js';
import { createSeriesStore, MARKET_SERIES_FORMAT_VERSION, type MarketSeries, type MarketSeriesIdentity } from '../../src/store/series.js';
import { readArchivedInput, readMarketInputs, readRoundInputs, type ObservationInput } from '../../src/store/snapshot.js';
import { candle, poolItem, SAMPLE_STRATEGY } from '../helpers.js';

const cfg = loadStrategy(SAMPLE_STRATEGY);
const ca = '0x1111111111111111111111111111111111111111';
const identity: MarketSeriesIdentity = { source: 'geckoterminal', network: 'eth', ca,
  poolAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', currency: 'usd', formatVersion: MARKET_SERIES_FORMAT_VERSION };

function database(t: TestContext) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return db;
}

function memberWithLegacy(t: TestContext) {
  const db = database(t);
  const pool = createPoolStore(db);
  pool.upsertPool([poolItem(ca, { chain: 'ethereum' })], 1);
  const member = pendingMember(pool.getPoolItem(ca)!, 1);
  createCandleStore(db).upsertCandles(ca, '15m', [candle(0, 500), candle(900_000, 501)]);
  createCandleStore(db).upsertCandles(ca, '1h', [candle(0, 600)]);
  createMomentStore(db).upsertMoments(ca, [{ moment: 1, barTime: 0, price: 1000 }], 1);
  return { db, member };
}

test('v3 → v5 增量迁移保留全部旧数据，绝不自动认领旧行情', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'alpha-series-v3-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'v3.sqlite');
  const old = openDatabase(filename);
  createCandleStore(old).upsertCandles(ca, '15m', [candle(0, 9)]);
  createMomentStore(old).upsertMoments(ca, [{ moment: 1, barTime: 0, price: 9 }], 3);
  createPoolStore(old).upsertPool([poolItem(ca)], 3);
  createAlertStore(old).recordAlert({ ca, tag: '30m_ath_pullback', firedAt: 3, payload: { price: 9 } });
  old.prepare('INSERT INTO api_usage VALUES (?, ?, ?)').run('2026-09-12', 2, 3);
  old.prepare('INSERT INTO runtime_state VALUES (?, ?, ?)').run('legacy', '{"preserved":true}', 3);
  old.prepare('INSERT INTO group_ca_history VALUES (?, ?, ?, ?, ?, ?, ?)').run(ca, 'ABC', 'ethereum', 'group', 1, 2, 3);
  const tables = ['candles', 'breakout_moments', 'ca_pool', 'alerts', 'api_usage', 'runtime_state', 'group_ca_history'];
  const before = tables.map((table) => old.prepare(`SELECT * FROM ${table}`).all());
  // 移除 v4 新表后恰好是旧 v3 schema；模拟部署前已有真实数据的数据库。
  old.exec('DROP TABLE series_candles; DROP TABLE series_moments; DROP TABLE market_series; PRAGMA user_version = 3;');
  old.close();
  const migrated = openDatabase(filename);
  try {
    assert.equal(migrated.pragma('user_version', { simple: true }), 7);
    assert.deepEqual(tables.map((table) => migrated.prepare(`SELECT * FROM ${table}`).all()), before);
    assert.equal(createSeriesStore(migrated).getActive('eth', ca), null);
    assert.deepEqual(migrated.prepare('SELECT * FROM market_series').all(), []);
    assert.deepEqual(migrated.prepare('SELECT * FROM series_candles').all(), []);
    assert.deepEqual(migrated.prepare('SELECT * FROM series_moments').all(), []);
  } finally { migrated.close(); }
  const reopened = openDatabase(filename);
  try { assert.deepEqual(tables.map((table) => reopened.prepare(`SELECT * FROM ${table}`).all()), before); }
  finally { reopened.close(); }
});

test('序列身份涵盖来源、链、CA、池和口径，EVM大小写幂等，Solana保持大小写', (t) => {
  const store = createSeriesStore(database(t));
  const first = store.ensureSeries(identity, 1);
  assert.deepEqual(store.ensureSeries({ ...identity, poolAddress: identity.poolAddress.toUpperCase() }, 99), first);
  const alternatives: MarketSeriesIdentity[] = [
    { ...identity, source: 'erwa' }, { ...identity, network: 'base' },
    { ...identity, ca: '0x2222222222222222222222222222222222222222' },
    { ...identity, poolAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    { ...identity, formatVersion: 2 },
    { ...identity, network: 'solana', ca: 'AbCd', poolAddress: 'PoolAb' },
    { ...identity, network: 'solana', ca: 'AbCd', poolAddress: 'Poolab' },
    { ...identity, network: 'solana', ca: 'abcd', poolAddress: 'PoolAb' },
  ];
  const all = [first, ...alternatives.map((next) => store.ensureSeries(next, 1))];
  assert.equal(new Set(all.map((item) => item.id)).size, all.length);
  for (const [index, series] of all.entries()) {
    store.upsertCandles(series.id, '15m', [candle(0, index + 1)]);
    store.upsertMoments(series.id, [{ moment: 1, barTime: 0, price: index + 1 }], 1);
  }
  for (const [index, series] of all.entries()) {
    assert.deepEqual(store.getCandles(series.id, '15m'), [candle(0, index + 1)]);
    assert.deepEqual(store.getMoments(series.id), [{ moment: 1, barTime: 0, price: index + 1 }]);
  }
});

test('序列需成功写入后显式激活；固定池不因创建其他池或来源而漂移', (t) => {
  const store = createSeriesStore(database(t));
  const first = store.ensureSeries(identity, 1);
  assert.equal(first.active, false);
  assert.equal(store.getActive('eth', ca), null);
  assert.throws(() => store.activateSeries(first.id, 2), { code: 'SERIES_EMPTY' });
  store.upsertCandles(first.id, '15m', [candle(0)]);
  assert.equal(store.getActive('eth', ca), null);
  const active = store.activateSeries(first.id, 3);
  assert.equal(active.active, true);
  assert.equal(active.activatedAt, 3);
  assert.deepEqual(store.activateSeries(first.id, 99), active);
  for (const candidate of [{ ...identity, poolAddress: 'another-pool' }, { ...identity, source: 'erwa' as const }]) {
    const other = store.ensureSeries(candidate, 4);
    store.upsertCandles(other.id, '15m', [candle(0)]);
    assert.throws(() => store.activateSeries(other.id, 5), { code: 'SERIES_ALREADY_PINNED' });
    assert.equal(store.getSeries(other.id)!.active, false);
    assert.equal(store.getActive('eth', ca)!.id, first.id);
  }
  const otherChain = store.ensureSeries({ ...identity, network: 'base' }, 4);
  store.upsertCandles(otherChain.id, '15m', [candle(0)]);
  assert.equal(store.activateSeries(otherChain.id, 5).active, true);
  assert.equal(store.getActive('base', ca)!.id, otherChain.id);
  assert.equal(store.getActive('eth', ca)!.id, first.id);
});

test('序列K线幂等、周期隔离、倒序与limit；坏批次回滚且不能写入未登记来源', (t) => {
  const store = createSeriesStore(database(t));
  const series = store.ensureSeries(identity, 1);
  store.upsertCandles(series.id, '15m', [candle(0), candle(900_000)]);
  store.upsertCandles(series.id, '15m', [candle(900_000, 20)]);
  store.upsertCandles(series.id, '1h', [candle(0, 30)]);
  assert.deepEqual(store.getCandles(series.id, '15m'), [candle(900_000, 20), candle(0)]);
  assert.deepEqual(store.getCandles(series.id, '15m', 1), [candle(900_000, 20)]);
  assert.deepEqual(store.getCandles(series.id, '15m', 0), []);
  assert.deepEqual(store.getCandles(series.id, '1h'), [candle(0, 30)]);
  assert.throws(() => store.getCandles(series.id, '15m', -1), RangeError);
  assert.throws(() => store.upsertCandles(series.id, '15m', [candle(0, 90), candle(1_800_000, NaN)]));
  assert.deepEqual(store.getCandles(series.id, '15m'), [candle(900_000, 20), candle(0)]);
  assert.throws(() => store.upsertCandles('missing', '15m', [candle(0)]), { code: 'SERIES_NOT_FOUND' });
  assert.throws(() => store.upsertMoments('missing', [{ moment: 1, barTime: 0, price: 10 }], 1), { code: 'SERIES_NOT_FOUND' });
});

test('外层事务可原子回滚多周期与激活，批次失败不会留下活动序列', (t) => {
  const db = database(t);
  const store = createSeriesStore(db);
  assert.throws(() => db.transaction(() => {
    const series = store.ensureSeries(identity, 1);
    store.upsertCandles(series.id, '15m', [candle(0)]);
    store.activateSeries(series.id, 2);
    store.upsertCandles(series.id, '1h', [candle(0, NaN)]);
  })());
  assert.equal(store.getActive('eth', ca), null);
  assert.deepEqual(db.prepare('SELECT * FROM market_series').all(), []);
  assert.deepEqual(db.prepare('SELECT * FROM series_candles').all(), []);
});

test('新序列时刻不会回退，重复写入保持首次detected_at', (t) => {
  const db = database(t);
  const store = createSeriesStore(db);
  const series = store.ensureSeries(identity, 1);
  const moments = [{ moment: 1 as const, barTime: 20, price: 3 }];
  store.upsertMoments(series.id, moments, 30);
  store.upsertMoments(series.id, moments, 40);
  store.upsertMoments(series.id, [{ moment: 1, barTime: 10, price: 9 }], 50);
  assert.deepEqual(store.getMoments(series.id), moments);
  assert.equal((db.prepare('SELECT detected_at FROM series_moments WHERE series_id = ?').get(series.id) as { detected_at: number }).detected_at, 30);
  assert.throws(() => store.upsertMoments(series.id, [{ moment: 1, barTime: 30, price: 10 }, { moment: 2, barTime: 30, price: NaN }], 60));
  assert.deepEqual(store.getMoments(series.id), moments);
});

test('seriesId=null的生产成员不读legacy K线及高点；undefined保留旧快照兼容', (t) => {
  const { db, member } = memberWithLegacy(t);
  const legacy = readRoundInputs(db, cfg, 4_000_000, [member])[0]!;
  assert.equal(legacy.candles15m.length, 2);
  assert.equal(legacy.candles60m.length, 1);
  assert.deepEqual(legacy.moments, [{ moment: 1, barTime: 0, price: 1000 }]);
  const pending = readRoundInputs(db, cfg, 4_000_000, [{ ...member, seriesId: null }])[0]!;
  assert.deepEqual(pending.candles15m, []);
  assert.deepEqual(pending.candles30m, []);
  assert.deepEqual(pending.candles60m, []);
  assert.deepEqual(pending.candles4h, []);
  assert.deepEqual(pending.moments, []);
});

test('seriesId只读该身份数据，核验CA和链，不继承legacy高点或其他池的K线', (t) => {
  const { db, member } = memberWithLegacy(t);
  const store = createSeriesStore(db);
  const selected = store.ensureSeries(identity, 1);
  const other = store.ensureSeries({ ...identity, poolAddress: 'other-pool' }, 1);
  store.upsertCandles(selected.id, '15m', [candle(0, 10), candle(900_000, 11)]);
  store.upsertCandles(selected.id, '1h', [candle(0, 20)]);
  store.upsertCandles(other.id, '15m', [candle(0, 999)]);
  store.upsertMoments(other.id, [{ moment: 1, barTime: 0, price: 999 }], 1);
  const input = readRoundInputs(db, cfg, 4_000_000, [{ ...member, seriesId: selected.id }])[0]!;
  assert.deepEqual(input.candles15m, [candle(0, 10), candle(900_000, 11)]);
  assert.deepEqual(input.candles60m, [candle(0, 20)]);
  assert.equal(input.candles30m.length, 1);
  assert.deepEqual(input.moments, []);
  for (const wrong of [
    { ...member, seriesId: selected.id, pool: { ...member.pool, ca: 'other-ca' } },
    { ...member, seriesId: selected.id, pool: { ...member.pool, chain: 'base' } },
    { ...member, seriesId: selected.id, pool: { ...member.pool, chain: null } },
    { ...member, seriesId: 'missing' },
  ]) {
    const rejected = readRoundInputs(db, cfg, 4_000_000, [wrong])[0]!;
    assert.deepEqual(rejected.candles15m, []);
    assert.deepEqual(rejected.candles60m, []);
    assert.deepEqual(rejected.moments, []);
  }
});

test('归档读取优先同链CA的活动序列', (t) => {
  const { db } = memberWithLegacy(t);
  const store = createSeriesStore(db);
  const series = store.ensureSeries(identity, 1);
  store.upsertCandles(series.id, '15m', [candle(0, 10)]);
  store.activateSeries(series.id, 2);
  const input = readArchivedInput(db, cfg, 4_000_000, ca)!;
  assert.deepEqual(input.candles15m, [candle(0, 10)]);
  assert.deepEqual(input.moments, []);
});


test('快照传播RPS界限；过期或禁止RPS时同时清除界限，防止旧下界误触发', (t) => {
  const { db, member } = memberWithLegacy(t);
  const bounds = { ...emptyBounds(), r16: { lower: 90, upper: 95, status: 'pass' as const } };
  const state = createRuntimeStore(db, () => 20);
  const round = initialRound(cfg, 1);
  round.members = [{ ...member, rpsBounds: bounds }];
  round.boardComplete = true;
  round.status = 'complete';
  round.completedAt = 10;
  state.saveRound(round);
  assert.deepEqual(readMarketInputs(db, cfg, 20)[0]!.rpsBounds, bounds);
  assert.equal(readMarketInputs(db, cfg, 20, false)[0]!.rpsBounds, undefined);
  assert.equal(readMarketInputs(db, cfg, 10 + cfg.schedule.mainLoopMinutes * 60_000)[0]!.rpsBounds, undefined);
});


test('活动序列来源或口径不兼容时快照不读取，保留数据供显式迁移', (t) => {
  for (const changed of [{ source: 'erwa' as const }, { formatVersion: MARKET_SERIES_FORMAT_VERSION + 1 }]) {
    const { db, member } = memberWithLegacy(t);
    const store = createSeriesStore(db);
    const incompatible: MarketSeries = store.ensureSeries({ ...identity, ...changed }, 1);
    store.upsertCandles(incompatible.id, '15m', [candle(0, 10), candle(900_000, 11)]);
    store.upsertCandles(incompatible.id, '1h', [candle(0, 12)]);
    store.upsertMoments(incompatible.id, [{ moment: 1, barTime: 0, price: 12 }], 1);
    store.activateSeries(incompatible.id, 2);
    const input: ObservationInput = readRoundInputs(db, cfg, 4_000_000, [{ ...member, seriesId: incompatible.id }])[0]!;
    assert.deepEqual(input.candles15m, []);
    assert.deepEqual(input.candles30m, []);
    assert.deepEqual(input.candles60m, []);
    assert.deepEqual(input.moments, []);
    assert.equal(store.getActive('eth', ca)!.id, incompatible.id);
    assert.equal(store.getCandles(incompatible.id, '15m').length, 2);
  }
});
