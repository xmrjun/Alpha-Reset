import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { loadStrategy } from '../../src/config/strategy.js';
import { openDatabase, type StoreDatabase } from '../../src/store/db.js';
import { createRuntimeStore, initialRound, isRoundFresh, pendingMember, type RoundSnapshot } from '../../src/store/runtime.js';
import { poolItem, SAMPLE_STRATEGY } from '../helpers.js';

const cfg = loadStrategy(SAMPLE_STRATEGY);

function database(t: TestContext) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return db;
}

function completed(startedAt: number, status: 'complete' | 'partial' = 'complete'): RoundSnapshot {
  const round = initialRound(cfg, startedAt);
  round.boardComplete = true;
  round.status = status;
  round.completedAt = startedAt + 100;
  round.sourceCount = 1;
  round.members = [pendingMember({ ...poolItem('a'), tokenName: null, firstSeenAt: 0, listedAt: 0, updatedAt: startedAt }, 1)];
  round.members[0]!.seriesId = 'series-a';
  round.members[0]!.rpsScores.r16 = 90;
  round.members[0]!.rpsBounds = { r16: { lower: 90, upper: 90, status: 'exact' }, r56: null, r96: null, r288: null, r672: null };
  round.coverage.r16 = { eligible: 1, available: 1, complete: true, source: 'kline', ageConfirmedByHistory: 1 };
  return round;
}

function seedRound(db: StoreDatabase, round: RoundSnapshot) {
  db.prepare('INSERT INTO runtime_state (key, payload, updated_at) VALUES (?, ?, ?)').run('last_round', JSON.stringify(round), 9999);
}

function cacheRows(db: StoreDatabase): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM runtime_state WHERE key = 'last_rps_round'").get() as { n: number }).n;
}

test('展示缓存缺失时只读回退已完成快照，不写数据库或制造计算时间', (t) => {
  const db = database(t);
  const old = completed(1000);
  seedRound(db, old);
  const state = createRuntimeStore(db, () => 900_000);
  assert.deepEqual(state.getRpsRound(), old);
  assert.equal(cacheRows(db), 0);
  assert.equal(state.getRpsRound()!.completedAt, 1100);
  assert.equal((db.prepare("SELECT updated_at FROM runtime_state WHERE key = 'last_round'").get() as { updated_at: number }).updated_at, 9999);
});

test('升级后首个运行态写入前保留同口径旧结果，当前成员可独立变化', (t) => {
  const db = database(t);
  const old = completed(1000);
  seedRound(db, old);
  const state = createRuntimeStore(db, () => 2000);
  const running = initialRound(cfg, 2000);
  running.boardComplete = true;
  state.saveRound(running);
  assert.equal(cacheRows(db), 1);
  assert.deepEqual(state.getRpsRound(), old);
  assert.deepEqual(state.getRound(), running);
  assert.equal(isRoundFresh(running, cfg, 2100), false);
});

test('不同策略口径的旧last_round不能被认领为新展示缓存', (t) => {
  const db = database(t);
  const old = completed(1000);
  old.strategyKey = 'old-market-contract';
  seedRound(db, old);
  const state = createRuntimeStore(db, () => 2000);
  state.saveRound(initialRound(cfg, 2000));
  assert.equal(cacheRows(db), 0);
  assert.equal(state.getRpsRound(), null);
});

test('running、failed、halted不会覆盖已完成展示缓存或刷新其基准时间', (t) => {
  const db = database(t);
  let now = 1100;
  const state = createRuntimeStore(db, () => now);
  const old = completed(1000);
  state.saveRound(old);
  const cached = db.prepare("SELECT payload, updated_at FROM runtime_state WHERE key = 'last_rps_round'").get();
  for (const status of ['running', 'failed', 'halted'] as const) {
    now += 1000;
    const next = initialRound(cfg, now);
    next.status = status;
    next.boardComplete = true;
    if (status !== 'running') next.completedAt = now;
    state.saveRound(next);
    assert.deepEqual(state.getRpsRound(), old);
    assert.deepEqual(db.prepare("SELECT payload, updated_at FROM runtime_state WHERE key = 'last_rps_round'").get(), cached);
    assert.equal(state.getRound()!.status, status);
  }
});

test('未完成整池或仅沿用旧评分的快照不能发布；完整partial结果可原子替换', (t) => {
  const db = database(t);
  const state = createRuntimeStore(db, () => 3000);
  for (const invalid of [
    { ...completed(1000), boardComplete: false },
    { ...completed(1100), rpsFromPreviousRound: true },
    { ...completed(1200), completedAt: null },
    { ...completed(1300), completedAt: 1200 },
  ]) {
    state.saveRound(invalid);
    assert.equal(state.getRpsRound(), null);
    assert.equal(cacheRows(db), 0);
  }
  const next = completed(2000, 'partial');
  next.failures = 1;
  state.saveRound(next);
  assert.deepEqual(state.getRpsRound(), next);
  assert.deepEqual(state.getRound(), next);
  assert.equal(state.getRpsRound()!.coverage.r16.ageConfirmedByHistory, 1);
});

test('当前快照写入失败时缓存认领一起回滚，不留下半次发布', (t) => {
  const db = database(t);
  const old = completed(1000);
  seedRound(db, old);
  db.exec(`CREATE TEMP TRIGGER reject_current_round BEFORE INSERT ON runtime_state
    WHEN NEW.key = 'last_round' BEGIN SELECT RAISE(ABORT, 'test write failure'); END;`);
  const state = createRuntimeStore(db, () => 2000);
  assert.throws(() => state.saveRound(initialRound(cfg, 2000)), /test write failure/);
  assert.equal(cacheRows(db), 0);
  assert.deepEqual(state.getRound(), old);
});

test('新结果发布写入失败时已完成缓存与当前快照都保持上一版本', (t) => {
  const db = database(t);
  const state = createRuntimeStore(db, () => 3000);
  const old = completed(1000);
  state.saveRound(old);
  db.exec(`CREATE TEMP TRIGGER reject_current_round BEFORE INSERT ON runtime_state
    WHEN NEW.key = 'last_round' BEGIN SELECT RAISE(ABORT, 'test write failure'); END;`);
  assert.throws(() => state.saveRound(completed(2000)), /test write failure/);
  assert.deepEqual(state.getRpsRound(), old);
  assert.deepEqual(state.getRound(), old);
});

test('采集中重启后仍可读取独立缓存，新一轮不覆盖旧值直至整轮完成', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'alpha-rps-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'test.sqlite');
  const first = openDatabase(filename);
  const old = completed(1000);
  const state = createRuntimeStore(first, () => 2000);
  state.saveRound(old);
  state.saveRound(initialRound(cfg, 2000));
  first.close();
  const restarted = openDatabase(filename);
  try {
    const fresh = createRuntimeStore(restarted, () => 4000);
    assert.equal(fresh.getRound()!.status, 'running');
    assert.deepEqual(fresh.getRpsRound(), old);
    fresh.saveRound(initialRound(cfg, 3000));
    assert.deepEqual(fresh.getRpsRound(), old);
    const next = completed(4000);
    fresh.saveRound(next);
    assert.deepEqual(fresh.getRpsRound(), next);
  } finally { restarted.close(); }
});
