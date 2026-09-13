import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { loadStrategy } from '../../src/config/strategy.js';
import { createAlertStore } from '../../src/store/alerts.js';
import { createCandleStore } from '../../src/store/candles.js';
import { openDatabase, type StoreDatabase } from '../../src/store/db.js';
import { createMomentStore } from '../../src/store/moments.js';
import { createPoolStore } from '../../src/store/pool.js';
import { createRuntimeStore, initialRound, pendingMember } from '../../src/store/runtime.js';
import { createSeriesStore, isSupportedMarketSeries, MARKET_SERIES_FORMAT_VERSION,
  type MarketSeries, type MarketSeriesIdentity } from '../../src/store/series.js';
import { readObservationInputs, readRoundInputs } from '../../src/store/snapshot.js';
import { candle, poolItem, SAMPLE_STRATEGY } from '../helpers.js';

const cfg = loadStrategy(SAMPLE_STRATEGY);
const ca = '0x' + 'ab'.repeat(20);
const gmgn: MarketSeriesIdentity = { source: 'gmgn', scope: 'token', network: 'eth', ca,
  poolAddress: null, currency: 'usd', formatVersion: MARKET_SERIES_FORMAT_VERSION };
const gecko: MarketSeriesIdentity = { source: 'geckoterminal', network: 'eth', ca,
  poolAddress: '0x' + 'cd'.repeat(20), currency: 'usd', formatVersion: MARKET_SERIES_FORMAT_VERSION };

function database(t: TestContext) {
  const db = openDatabase(':memory:');
  t.after(() => { if (db.open) db.close(); });
  return db;
}
function fileDatabase(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'alpha-gmgn-v5-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'store.sqlite');
}

// 还原真实 v4 父表定义；其余表从未改变，数据与子表外键均留在原处。
function restoreV4Parent(db: StoreDatabase) {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => db.exec(`
      CREATE TABLE market_series_v4 (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('geckoterminal', 'erwa')),
        network TEXT NOT NULL, ca TEXT NOT NULL, pool_address TEXT NOT NULL,
        currency TEXT NOT NULL CHECK (currency = 'usd'),
        format_version INTEGER NOT NULL CHECK (format_version > 0),
        created_at INTEGER NOT NULL, activated_at INTEGER,
        active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
        UNIQUE (source, network, ca, pool_address, currency, format_version)
      ) WITHOUT ROWID;
      INSERT INTO market_series_v4 SELECT id, source, network, ca, pool_address, currency,
        format_version, created_at, activated_at, active FROM market_series;
      DROP TABLE market_series;
      ALTER TABLE market_series_v4 RENAME TO market_series;
      CREATE UNIQUE INDEX idx_market_series_active ON market_series(network, ca) WHERE active = 1;
      PRAGMA user_version = 4;
    `))();
  } finally { db.pragma('foreign_keys = ON'); }
}

const untouchedTables = ['candles', 'breakout_moments', 'ca_pool', 'alerts', 'api_usage', 'runtime_state',
  'group_ca_history', 'series_candles', 'series_moments'];
const legacyColumns = 'id, source, network, ca, pool_address, currency, format_version, created_at, activated_at, active';
function preservedData(db: StoreDatabase) {
  return { series: db.prepare(`SELECT ${legacyColumns} FROM market_series ORDER BY id`).all(),
    tables: untouchedTables.map((name) => db.prepare(`SELECT * FROM ${name}`).all()) };
}

test('v4→v5保留所有历史、原seriesId和外键；显式pool与旧调用幂等且重启不迁移第二次', (t) => {
  const filename = fileDatabase(t);
  const old = openDatabase(filename);
  const store = createSeriesStore(old);
  const first = store.ensureSeries(gecko, 10);
  const expectedId = createHash('sha256').update(JSON.stringify([
    gecko.source, gecko.network, gecko.ca, gecko.poolAddress, gecko.currency, gecko.formatVersion,
  ])).digest('hex');
  assert.equal(first.id, expectedId);
  const second = store.ensureSeries({ ...gecko, source: 'erwa' }, 11);
  for (const [index, item] of [first, second].entries()) {
    store.upsertCandles(item.id, '15m', [candle(0, index + 1), candle(900_000, index + 2)]);
    store.upsertCandles(item.id, '1h', [candle(0, index + 4)]);
    store.upsertMoments(item.id, [{ moment: 1, barTime: 0, price: index + 4 }], 12);
  }
  const active = store.activateSeries(first.id, 13);
  createCandleStore(old).upsertCandles(ca, '15m', [candle(0, 500)]);
  createMomentStore(old).upsertMoments(ca, [{ moment: 1, barTime: 0, price: 999 }], 14);
  createPoolStore(old).upsertPool([poolItem(ca, { chain: 'ethereum' })], 14);
  const alertId = createAlertStore(old).recordAlert({ ca, tag: '30m_ath_pullback', firedAt: 14,
    payload: { marketSeries: { ...active, scope: undefined }, nested: { preserve: [1, null, 'history'] } }, pushed: true });
  old.prepare('INSERT INTO api_usage VALUES (?, ?, ?)').run('2026-09-12', 42, 14);
  old.prepare('INSERT INTO runtime_state VALUES (?, ?, ?)').run('last_round', JSON.stringify({ seriesId: first.id }), 14);
  old.prepare('INSERT INTO group_ca_history VALUES (?, ?, ?, ?, ?, ?, ?)').run(ca, 'ABC', 'ethereum', 'group', 1, 2, 14);
  restoreV4Parent(old);
  const before = preservedData(old);
  assert.deepEqual(old.pragma('foreign_key_check'), []);
  old.close();

  const migrated = openDatabase(filename);
  assert.equal(migrated.pragma('user_version', { simple: true }), 5);
  assert.equal(migrated.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(migrated.pragma('foreign_key_check'), []);
  assert.deepEqual(preservedData(migrated), before);
  for (const table of ['series_candles', 'series_moments']) {
    const foreignKeys = migrated.pragma(`foreign_key_list(${table})`) as { table: string }[];
    assert.deepEqual(foreignKeys.map((row) => row.table), ['market_series']);
  }
  const afterStore = createSeriesStore(migrated);
  assert.deepEqual(afterStore.getActive('eth', ca), active);
  assert.deepEqual(afterStore.ensureSeries({ ...gecko, scope: 'pool' }, 100), active);
  assert.deepEqual(afterStore.ensureSeries(gecko, 200), active);
  assert.throws(() => migrated.prepare('DELETE FROM market_series WHERE id = ?').run(first.id), /FOREIGN KEY/);
  assert.throws(() => migrated.prepare('INSERT INTO series_candles VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('unknown-series', '15m', 0, 1, 1, 1, 1, 1), /FOREIGN KEY/);
  migrated.close();
  const reopened = openDatabase(filename);
  try {
    assert.deepEqual(preservedData(reopened), before);
    assert.equal(reopened.pragma('foreign_keys', { simple: true }), 1);
    assert.deepEqual(reopened.pragma('foreign_key_check'), []);
    assert.deepEqual(createSeriesStore(reopened).getActive('eth', ca), active);
    assert.ok(createAlertStore(reopened).recordAlert({ ca, tag: 'low_vol_30m', firedAt: 15, payload: {} }) > alertId);
  } finally { reopened.close(); }
});

test('v5迁移发现孤立子表时完整回滚，保留v4表结构与历史供修复', (t) => {
  const filename = fileDatabase(t);
  const old = openDatabase(filename);
  createSeriesStore(old).ensureSeries(gecko, 1);
  restoreV4Parent(old);
  old.pragma('foreign_keys = OFF');
  old.prepare('INSERT INTO series_moments VALUES (?, ?, ?, ?, ?)').run('orphan', 1, 0, 10, 1);
  const before = preservedData(old);
  old.close();
  assert.throws(() => openDatabase(filename), /外键校验失败/);
  const inspect = new Database(filename);
  try {
    assert.equal(inspect.pragma('user_version', { simple: true }), 4);
    assert.deepEqual(preservedData(inspect), before);
    assert.equal((inspect.pragma('table_info(market_series)') as { name: string }[]).some((row) => row.name === 'scope'), false);
    assert.deepEqual(inspect.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'market_series_v5'").get(), { n: 0 });
  } finally { inspect.close(); }
});

test('GMGN身份强制token/null池，涵盖来源、链、CA及版本且大小写规范化幂等', (t) => {
  const db = database(t); const store = createSeriesStore(db);
  const first = store.ensureSeries(gmgn, 1);
  assert.equal(first.scope, 'token'); assert.equal(first.poolAddress, null); assert.equal(first.active, false);
  assert.deepEqual(store.ensureSeries({ ...gmgn, ca: ca.toUpperCase() }, 99), first);
  const identities: MarketSeriesIdentity[] = [gecko, { ...gmgn, network: 'base' },
    { ...gmgn, ca: '0x' + 'ef'.repeat(20) }, { ...gmgn, formatVersion: 2 },
    { ...gmgn, network: 'solana', ca: 'AbCd' }, { ...gmgn, network: 'solana', ca: 'abcd' }];
  assert.equal(new Set([first.id, ...identities.map((item) => store.ensureSeries(item, 1).id)]).size, identities.length + 1);
  for (const invalid of [
    { ...gmgn, scope: 'pool', poolAddress: gecko.poolAddress }, { ...gmgn, poolAddress: gecko.poolAddress },
    { ...gmgn, scope: undefined }, { ...gecko, poolAddress: null }, { ...gecko, scope: 'token' },
    { ...gmgn, source: 'unapproved' }, { ...gmgn, currency: 'eur' },
  ]) assert.throws(() => store.ensureSeries(invalid as unknown as MarketSeriesIdentity, 1), { code: 'SERIES_IDENTITY_INVALID' });
  assert.throws(() => db.prepare(`INSERT INTO market_series
    (id,source,scope,network,ca,pool_address,currency,format_version,created_at)
    VALUES ('duplicate-token','gmgn','token','eth',?,NULL,'usd',1,1)`).run(ca), /UNIQUE/);
  const insert = db.prepare(`INSERT INTO market_series
    (id,source,scope,network,ca,pool_address,currency,format_version,created_at)
    VALUES (@id,@source,@scope,'eth',@ca,@poolAddress,'usd',1,1)`);
  for (const [i, values] of [
    { source: 'gmgn', scope: 'pool', poolAddress: gecko.poolAddress },
    { source: 'gmgn', scope: 'token', poolAddress: gecko.poolAddress },
    { source: 'geckoterminal', scope: 'token', poolAddress: null },
    { source: 'erwa', scope: 'pool', poolAddress: null },
  ].entries()) assert.throws(() => insert.run({ ...values, id: `invalid-${i}`, ca }), /CHECK/);
});

test('GMGN与Gecko历史及高点分离，首次成功才能激活，任一来源均不能替换已有活动序列', (t) => {
  for (const firstIdentity of [gecko, gmgn]) {
    const db = database(t); const store = createSeriesStore(db);
    const first = store.ensureSeries(firstIdentity, 1);
    const second: MarketSeries = store.ensureSeries(firstIdentity.source === 'gmgn' ? gecko : gmgn, 1);
    assert.throws(() => store.activateSeries(first.id, 2), { code: 'SERIES_EMPTY' });
    store.upsertCandles(first.id, '15m', [candle(0, 10)]);
    store.upsertCandles(second.id, '15m', [candle(0, 100)]);
    store.upsertMoments(second.id, [{ moment: 1, barTime: 0, price: 100 }], 3);
    assert.equal(store.getActive('eth', ca), null);
    const active = store.activateSeries(first.id, 4);
    assert.deepEqual(store.activateSeries(first.id, 99), active);
    assert.throws(() => store.activateSeries(second.id, 5), { code: 'SERIES_ALREADY_PINNED' });
    assert.equal(store.getActive('eth', ca)!.id, first.id);
    assert.deepEqual(store.getCandles(first.id, '15m'), [candle(0, 10)]);
    assert.deepEqual(store.getCandles(second.id, '15m'), [candle(0, 100)]);
    assert.deepEqual(store.getMoments(first.id), []);
    assert.deepEqual(store.getMoments(second.id), [{ moment: 1, barTime: 0, price: 100 }]);
  }
});

test('GMGN快照只读同链CA的token序列；观察池解析active且不混入旧行情或旧高点', (t) => {
  const db = database(t); const store = createSeriesStore(db);
  createPoolStore(db).upsertPool([poolItem(ca, { chain: 'ethereum' })], 1);
  const member = pendingMember(createPoolStore(db).getPoolItem(ca)!, 1);
  const selected = store.ensureSeries(gmgn, 1); const other = store.ensureSeries(gecko, 1);
  createCandleStore(db).upsertCandles(ca, '15m', [candle(0, 500)]);
  createMomentStore(db).upsertMoments(ca, [{ moment: 1, barTime: 0, price: 500 }], 1);
  store.upsertCandles(other.id, '15m', [candle(0, 900)]);
  store.upsertMoments(other.id, [{ moment: 2, barTime: 0, price: 900 }], 1);
  store.upsertCandles(selected.id, '15m', [candle(0, 10), candle(900_000, 11)]);
  store.upsertCandles(selected.id, '1h', [candle(0, 12)]);
  store.upsertMoments(selected.id, [{ moment: 3, barTime: 0, price: 12 }], 1);
  store.activateSeries(selected.id, 2);
  const input = readRoundInputs(db, cfg, 4_000_000, [{ ...member, seriesId: selected.id }])[0]!;
  assert.deepEqual(input.candles15m, [candle(0, 10), candle(900_000, 11)]);
  assert.deepEqual(input.candles60m, [candle(0, 12)]);
  assert.deepEqual(input.moments, [{ moment: 3, barTime: 0, price: 12 }]);
  assert.equal(input.candles30m.length, 1);
  const round = initialRound(cfg, 1); round.boardComplete = true;
  round.members = [{ ...member, seriesId: null }];
  createRuntimeStore(db).saveObservationRound(round);
  assert.deepEqual(readObservationInputs(db, cfg, 4_000_000)[0]!.candles15m, input.candles15m);
  for (const rejected of [
    { ...member, seriesId: null }, { ...member, seriesId: 'missing' },
    { ...member, seriesId: selected.id, pool: { ...member.pool, ca: '0x' + 'ef'.repeat(20) } },
    { ...member, seriesId: selected.id, pool: { ...member.pool, chain: 'base' } },
    { ...member, seriesId: selected.id, pool: { ...member.pool, chain: null } },
  ]) {
    const value = readRoundInputs(db, cfg, 4_000_000, [rejected])[0]!;
    assert.deepEqual(value.candles15m, []); assert.deepEqual(value.candles60m, []); assert.deepEqual(value.moments, []);
  }
  const future = store.ensureSeries({ ...gmgn, formatVersion: MARKET_SERIES_FORMAT_VERSION + 1 }, 3);
  store.upsertCandles(future.id, '15m', [candle(0, 200)]);
  assert.deepEqual(readRoundInputs(db, cfg, 4_000_000, [{ ...member, seriesId: future.id }])[0]!.candles15m, []);
  // 即使绕过 SQL CHECK 导入损坏记录，读取白名单仍拒绝错误 scope / currency。
  db.pragma('ignore_check_constraints = ON');
  try {
    for (const [column, value] of [['scope', 'pool'], ['currency', 'eur']] as const) {
      db.prepare(`UPDATE market_series SET ${column} = ? WHERE id = ?`).run(value, selected.id);
      assert.deepEqual(readRoundInputs(db, cfg, 4_000_000, [{ ...member, seriesId: selected.id }])[0]!.candles15m, []);
      assert.deepEqual(readObservationInputs(db, cfg, 4_000_000)[0]!.candles15m, []);
      db.prepare('UPDATE market_series SET scope = ?, currency = ? WHERE id = ?').run('token', 'usd', selected.id);
    }
  } finally { db.pragma('ignore_check_constraints = OFF'); }
});

test('支持来源白名单同时检查scope、空池、USD和版本，不接受Erwa或畸形身份', (t) => {
  const store = createSeriesStore(database(t));
  const token = store.ensureSeries(gmgn, 1); const pool = store.ensureSeries(gecko, 1);
  assert.equal(isSupportedMarketSeries(token), true); assert.equal(isSupportedMarketSeries(pool), true);
  assert.equal(isSupportedMarketSeries(null), false); assert.equal(isSupportedMarketSeries(undefined), false);
  for (const malformed of [
    { ...token, scope: 'pool' }, { ...token, poolAddress: gecko.poolAddress },
    { ...token, source: 'unknown' }, { ...pool, source: 'erwa' }, { ...pool, scope: 'token' },
    { ...pool, poolAddress: null }, { ...token, currency: 'eur' }, { ...token, formatVersion: 2 },
    { ...token, ca: '' }, { ...token, ca: ca.toUpperCase() }, { ...token, network: ' eth' },
  ]) assert.equal(isSupportedMarketSeries(malformed as unknown as MarketSeries), false);
});
