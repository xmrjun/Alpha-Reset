import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { loadStrategy } from '../../src/config/strategy.js';
import { emptyBounds } from '../../src/indicators/observation-rps.js';
import { emptyScores } from '../../src/market.js';
import { openDatabase } from '../../src/store/db.js';
import { createRuntimeStore, initialRound, pendingMember } from '../../src/store/runtime.js';
import { poolItem, SAMPLE_STRATEGY } from '../helpers.js';

const cfg = loadStrategy(SAMPLE_STRATEGY);
function fixture(t: TestContext) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  return { db, state: createRuntimeStore(db, () => 9000) };
}
function complete(at: number) {
  const round = initialRound(cfg, at);
  round.boardComplete = true; round.status = 'complete'; round.completedAt = at + 1;
  round.sourceCount = 1;
  round.members = [pendingMember({ ...poolItem('a'), tokenName: null, firstSeenAt: 0, listedAt: 0, updatedAt: at }, 1)];
  round.members[0]!.seriesId = 'source-a';
  round.members[0]!.rpsDisplayBounds = { ...emptyBounds(), r16: { lower: 10, upper: 80, status: 'unknown' } };
  return round;
}

test('collection 与 observation 独立保存，新 board 未完成不清除完整池或评分', (t) => {
  const { state, db } = fixture(t);
  const score = complete(1000);
  state.saveRound(score);
  const scored = db.prepare("SELECT key, payload, updated_at FROM runtime_state WHERE key IN ('last_round', 'last_rps_round') ORDER BY key").all();
  const collection = complete(2000);
  collection.members[0]!.rpsDisplayBounds = emptyBounds();
  collection.status = 'running'; collection.completedAt = null;
  state.saveCollectionRound(collection);
  assert.deepEqual(state.getObservationRound(), collection);
  const next = initialRound(cfg, 3000);
  state.saveCollectionRound(next);
  assert.deepEqual(state.getCollectionRound(), next);
  assert.deepEqual(state.getObservationRound(), collection);
  assert.deepEqual(db.prepare("SELECT key, payload, updated_at FROM runtime_state WHERE key IN ('last_round', 'last_rps_round') ORDER BY key").all(), scored);
});

test('空时点只更新当期覆盖率，非空展示缓存保留原 payload 与更新时间', (t) => {
  const { state, db } = fixture(t);
  const old = complete(1000);
  state.saveRound(old);
  const saved = db.prepare("SELECT payload, updated_at FROM runtime_state WHERE key = 'last_rps_round'").get();
  const current = complete(2000);
  current.members[0]!.rpsScores = emptyScores(); current.members[0]!.rpsDisplayBounds = emptyBounds();
  current.rpsRevision = 1; current.rpsInputKey = 'empty-current';
  state.saveRound(current);
  assert.deepEqual(state.getRound(), current);
  assert.deepEqual(state.getRpsRound(), old);
  assert.deepEqual(db.prepare("SELECT payload, updated_at FROM runtime_state WHERE key = 'last_rps_round'").get(), saved);
  current.members[0]!.rpsDisplayBounds!.r16 = { lower: 0, upper: 50, status: 'unknown' };
  current.rpsRevision = 2; current.rpsInputKey = 'one-current-endpoint';
  state.saveRound(current);
  assert.deepEqual(state.getRpsRound(), current, '未达到规则阈值也可发布明确的数学范围');
});

test('首次空评分允许只读解释覆盖率，旧完整 running 池可作为重算输入', (t) => {
  const { state, db } = fixture(t);
  const running = complete(1000);
  running.status = 'running'; running.completedAt = null;
  db.prepare('INSERT INTO runtime_state (key, payload, updated_at) VALUES (?, ?, ?)').run('last_round', JSON.stringify(running), 1000);
  assert.deepEqual(state.getObservationRound(), running);
  assert.equal(state.getRpsRound(), null);
  const current = complete(2000);
  current.members[0]!.rpsDisplayBounds = emptyBounds();
  state.saveRound(current);
  assert.deepEqual(state.getRpsRound(), current);
  assert.equal(db.prepare("SELECT 1 FROM runtime_state WHERE key = 'last_rps_round'").get(), undefined);
});

test('保存完整采集池失败时两个采集键一起回滚，评分键保持不变', (t) => {
  const { state, db } = fixture(t);
  const old = complete(1000);
  state.saveRound(old);
  db.exec(`CREATE TEMP TRIGGER reject_observation BEFORE INSERT ON runtime_state
    WHEN NEW.key = 'observation_round' BEGIN SELECT RAISE(ABORT, 'test rollback'); END;`);
  assert.throws(() => state.saveCollectionRound(complete(2000)), /test rollback/);
  assert.equal(state.getCollectionRound(), null);
  assert.deepEqual(state.getRound(), old);
  assert.deepEqual(state.getRpsRound(), old);
});
