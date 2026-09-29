import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createAuthWatch } from '../../src/scheduler/auth-watch.js';
import { openDatabase } from '../../src/store/db.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T = 1_000_000 * MIN;

function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  t.after(() => { if (db.open) db.close(); });
  const sent: string[] = [];
  let failNext = false;
  const watch = createAuthWatch({ db, alert: async (message) => {
    if (failNext) { failNext = false; throw new Error('telegram down'); }
    sent.push(message);
  } });
  const latch = (key: string, value: Record<string, unknown>) => db
    .prepare('INSERT INTO runtime_state (key,payload,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload')
    .run(key, JSON.stringify(value), T);
  const unlatch = (key: string) => db.prepare('DELETE FROM runtime_state WHERE key=?').run(key);
  return { db, sent, watch, latch, unlatch, failOnce: () => { failNext = true; } };
}

test('停摆不到一小时不打扰：一次探测就恢复的抖动不值得发消息', async (t) => {
  const f = fixture(t);
  f.latch('binance_auth_error', { httpStatus: 401, at: T, since: T });
  await f.watch.check(T + 59 * MIN);
  assert.deepEqual(f.sent, []);
});

test('停摆满一小时告警一次，说明来源、状态码和时长，同一时刻重复检查不重复发', async (t) => {
  const f = fixture(t);
  f.latch('binance_auth_error', { httpStatus: 401, at: T + 30 * MIN, since: T });
  await f.watch.check(T + HOUR);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!, /Binance/);
  assert.match(f.sent[0]!, /401/);
  assert.match(f.sent[0]!, /1 小时/);
  await f.watch.check(T + HOUR + MIN);
  assert.equal(f.sent.length, 1, '已告警的停摆在提醒间隔内不得重复');
});

test('长期不恢复每 6 小时提醒一次', async (t) => {
  const f = fixture(t);
  f.latch('gmgn_auth_error', { httpStatus: 403, at: T, since: T });
  await f.watch.check(T + HOUR);
  await f.watch.check(T + 6 * HOUR + 59 * MIN);
  assert.equal(f.sent.length, 1, '距上次告警不足 6 小时');
  await f.watch.check(T + 7 * HOUR);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1]!, /GMGN/);
  assert.match(f.sent[1]!, /7 小时/);
});

test('告警过的来源恢复后通知一次，之后保持安静', async (t) => {
  const f = fixture(t);
  f.latch('binance_auth_error', { httpStatus: 401, at: T, since: T });
  await f.watch.check(T + 2 * HOUR);
  f.unlatch('binance_auth_error');
  await f.watch.check(T + 2 * HOUR + MIN);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1]!, /恢复/);
  await f.watch.check(T + 3 * HOUR);
  assert.equal(f.sent.length, 2, '恢复通知只发一次');
});

test('从没告警过的来源不会凭空发恢复通知', async (t) => {
  const f = fixture(t);
  f.latch('binance_auth_error', { httpStatus: 401, at: T, since: T });
  await f.watch.check(T + 10 * MIN);
  f.unlatch('binance_auth_error');
  await f.watch.check(T + 20 * MIN);
  assert.deepEqual(f.sent, []);
});

test('两个来源互不影响', async (t) => {
  const f = fixture(t);
  f.latch('binance_auth_error', { httpStatus: 401, at: T, since: T });
  f.latch('gmgn_auth_error', { httpStatus: 401, at: T + 90 * MIN, since: T + 90 * MIN });
  await f.watch.check(T + 2 * HOUR);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!, /Binance/);
  await f.watch.check(T + 3 * HOUR);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1]!, /GMGN/);
});

test('没有 since 的旧标记按 at 计时', async (t) => {
  const f = fixture(t);
  f.latch('binance_auth_error', { httpStatus: 401, at: T });
  await f.watch.check(T + HOUR);
  assert.equal(f.sent.length, 1);
});

test('通知通道失败不算已告警，下一次检查重试，且不影响另一个来源', async (t) => {
  const f = fixture(t);
  f.latch('binance_auth_error', { httpStatus: 401, at: T, since: T });
  f.latch('gmgn_auth_error', { httpStatus: 401, at: T, since: T });
  f.failOnce();
  await f.watch.check(T + HOUR);
  assert.equal(f.sent.length, 1, 'Binance 发送失败，GMGN 仍应发出');
  assert.match(f.sent[0]!, /GMGN/);
  await f.watch.check(T + HOUR + MIN);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1]!, /Binance/);
});

test('损坏的标记行被忽略，不抛错也不发消息', async (t) => {
  const f = fixture(t);
  f.latch('binance_auth_error', { httpStatus: 'oops' });
  await f.watch.check(T + 5 * HOUR);
  assert.deepEqual(f.sent, []);
});
