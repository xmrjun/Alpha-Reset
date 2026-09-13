import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { loadStrategy } from '../../src/config/strategy.js';
import { openDatabase } from '../../src/store/db.js';
import { createRuntimeStore, initialRound } from '../../src/store/runtime.js';
import { SAMPLE_STRATEGY } from '../helpers.js';
const cfg = loadStrategy(SAMPLE_STRATEGY);
function fixture(t: TestContext) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  return { db, state: createRuntimeStore(db, () => 9000) };
}
function observed(startedAt: number, observedAt = startedAt) {
  const round = initialRound(cfg, startedAt); round.boardComplete = true; round.status = 'complete';
  round.observedAt = observedAt; round.completedAt = observedAt; round.addedCount = 1; round.removedCount = 0;
  return round;
}

test('独立发现的观察池不会被旧collector进度或更新完成时间覆盖', (t) => {
  const { state } = fixture(t);
  const next = observed(2000, 2200); state.saveObservationRound(next);
  const old = observed(1000, 1000); old.completedAt = 4000;
  state.saveCollectionRound(old);
  assert.deepEqual(state.getObservationRound(), next);
  state.saveCollectionRound(observed(5000), false);
  assert.deepEqual(state.getObservationRound(), next);
  assert.equal(state.getCollectionRound()!.startedAt, 5000);
  const attempt = initialRound(cfg, 6000); attempt.status = 'failed'; attempt.completedAt = 6100;
  state.saveDiscoveryRound(attempt);
  assert.deepEqual(state.getObservationRound(), next);
  assert.deepEqual(state.getDiscoveryRound(), attempt);
  assert.equal(state.getRound(), null); assert.equal(state.getRpsRound(), null);
});

test('公平队列按首次登记顺序等待，尝试移至队尾，规范CA幂等且跨链隔离', (t) => {
  const { state } = fixture(t);
  const a = state.ensureCollectionQueue('eth', ('0x' + 'AB'.repeat(20)));
  const b = state.ensureCollectionQueue('eth', ('0x' + 'de'.repeat(20)));
  assert.equal(a.attemptedAt, null); assert.ok(a.sequence < b.sequence);
  assert.deepEqual(state.ensureCollectionQueue('eth', ('0x' + 'ab'.repeat(20))), a);
  const moved = state.recordCollectionAttempt('eth', ('0x' + 'ab'.repeat(20)), 1000);
  assert.ok(moved.sequence > b.sequence); assert.equal(moved.attemptedAt, 1000);
  const newMember = state.ensureCollectionQueue('eth', ('0x' + '12'.repeat(20)));
  assert.ok(newMember.sequence > moved.sequence, '新成员不能反复插队使旧队尾饿死');
  assert.equal(state.getCollectionAttempt('base', ('0x' + 'ab'.repeat(20))), null);
  assert.deepEqual(state.getCollectionAttempt('eth', ('0x' + 'AB'.repeat(20))), moved);
});

test('队列顺序与请求前尝试记录跨数据库重启保留，即使时钟相同也能公平轮换', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'alpha-queue-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'queue.db');
  let db = openDatabase(path);
  let state = createRuntimeStore(db, () => 1000);
  state.ensureCollectionQueue('solana', 'a'); const b = state.ensureCollectionQueue('solana', 'b');
  const attempted = state.recordCollectionAttempt('solana', 'a', 1000);
  db.close(); db = openDatabase(path); t.after(() => db.close()); state = createRuntimeStore(db, () => 1000);
  assert.deepEqual(state.getCollectionAttempt('solana', 'a'), attempted);
  assert.deepEqual(state.getCollectionAttempt('solana', 'b'), b);
  assert.ok(state.recordCollectionAttempt('solana', 'b', 1000).sequence > attempted.sequence);
});

test('覆盖率统计逐字段往返，新增的失活剔除数不会被快照 schema 静默丢弃', (t) => {
  const { state } = fixture(t);
  const round = observed(9000);
  const full = { eligible: 200, available: 160, complete: false, source: 'kline' as const,
    unknownAge: 3, inactive: 37, ageConfirmedByHistory: 2, missingCurrent: 30, missingStart: 7, boundedPassCount: 5 };
  for (const key of Object.keys(round.coverage) as (keyof typeof round.coverage)[]) round.coverage[key] = { ...full };
  state.saveRound(round);
  const loaded = state.getRound();
  assert.ok(loaded, '快照应可读回');
  for (const key of Object.keys(round.coverage) as (keyof typeof round.coverage)[]) {
    assert.deepEqual(loaded.coverage[key], full, `${key} 覆盖率字段应完整往返`);
  }
});
