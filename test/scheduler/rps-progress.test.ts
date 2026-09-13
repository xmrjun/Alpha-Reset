import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { GeckoTerminalError } from '../../src/api/geckoterminal.js';
import { loadStrategy } from '../../src/config/strategy.js';
import { INTERVAL_MS, RPS_KEYS, emptyScores } from '../../src/market.js';
import type { Notification } from '../../src/notify/telegram.js';
import { createScheduler } from '../../src/scheduler/main.js';
import { createQuotaGuard } from '../../src/scheduler/quota.js';
import { openDatabase } from '../../src/store/db.js';
import { createPoolStore } from '../../src/store/pool.js';
import { createRuntimeStore, initialRound, isRoundFresh, pendingMember } from '../../src/store/runtime.js';
import type { Candle, DexSnapshot } from '../../src/types.js';
import { boardPoolItem, candle, poolItem, SAMPLE_STRATEGY } from '../helpers.js';

const now = 100 * INTERVAL_MS['1d'];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function bars(close = 100): Candle[] {
  return Array.from({ length: 800 }, (_, index) => candle(now - (800 - index) * INTERVAL_MS['15m'], close + index / 100));
}

function fixture(t: TestContext, addresses = ['a', 'b', 'c'], pauseBoard = false) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  const quota = createQuotaGuard(db, cfg, () => now);
  const notifications: Notification[] = [];
  const requests: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const boardStarted = deferred<void>();
  const board = deferred<void>();
  const gates = addresses.map(() => deferred<Candle[]>());
  const entered = addresses.map(() => deferred<void>());
  const state = createRuntimeStore(db, () => now);
  const client = {
    async getTokenUsage() { quota.onCall(); return { usedToday: 0, remainingToday: 10_500, dailyLimit: 10_500 }; },
    async getBoardSummary() {
      quota.onCall(); boardStarted.resolve();
      if (pauseBoard) await board.promise;
      return addresses.map((ca, index) => boardPoolItem(ca, { totalMentions: addresses.length - index }));
    },
    async getDexScreener(ca: string): Promise<DexSnapshot> {
      return { pairAddress: 'pool-' + ca, chainId: 'solana', priceUsd: 1, marketCap: 100_000, liquidityUsd: 50_000,
        priceChange: { m5: null, h1: null, h6: null, h24: 99 }, pairCreatedAt: now - 60 * INTERVAL_MS['1d'] };
    },
    async getKline() { return assert.fail('Gecko采集不得回退二娃'); },
  };
  const source = {
    async getCandles15m(_network: string, _pool: string, _limit = 1000, ca?: string): Promise<Candle[]> {
      const index = requests.length;
      requests.push(ca ?? 'missing-target');
      entered[index]!.resolve();
      return gates[index]!.promise;
    },
  };
  const scheduler = createScheduler({ db, cfg, client, quota, klineSource: source, clock: () => now,
    notifier: { async notify(notification: Notification) { notifications.push(notification); return { tags: notification.tags, messages: 0 }; } },
    log: (entry) => logs.push(entry) });
  return { db, cfg, state, scheduler, notifications, requests, logs, gates, entered, board, boardStarted };
}

function assertNoIntermediateRanking(f: ReturnType<typeof fixture>, memberCount: number) {
  const round = f.state.getRound()!;
  assert.equal(round.status, 'running');
  assert.equal(round.completedAt, null);
  assert.equal(round.members.length, memberCount);
  assert.equal(round.rpsFromPreviousRound, false);
  assert.equal(isRoundFresh(round, f.cfg, now), false);
  for (const member of round.members) {
    assert.deepEqual(member.rpsScores, emptyScores());
    assert.equal(member.result, null);
  }
  for (const key of RPS_KEYS) {
    assert.equal(round.coverage[key].available, 0);
    assert.equal(round.coverage[key].complete, false);
  }
  assert.equal(f.notifications.length, 0);
  assert.equal(f.logs.filter((entry) => entry.event === 'evaluate').length, 0);
}

test('逐币成功及失败立即发布采集进度，但全池处理前不排名或通知', async (t) => {
  const f = fixture(t);
  const running = f.scheduler.runOnce(now);
  try {
    await f.entered[0]!.promise;
    assertNoIntermediateRanking(f, 3);
    assert.equal(f.state.getRpsRound(), null);
    f.gates[0]!.resolve(bars());
    await f.entered[1]!.promise;
    let snapshot = f.state.getRound()!;
    assert.equal(snapshot.members[0]!.klineStatus, 'ready');
    assert.equal(typeof snapshot.members[0]!.seriesId, 'string');
    assert.equal(snapshot.members[1]!.klineStatus, 'skipped');
    assert.equal(snapshot.sourceCount, 3);
    assertNoIntermediateRanking(f, 3);
    f.gates[1]!.reject(new GeckoTerminalError('GECKO_HTTP', '测试行情失败', 404));
    await f.entered[2]!.promise;
    snapshot = f.state.getRound()!;
    assert.equal(snapshot.members[1]!.klineStatus, 'error');
    assert.equal(snapshot.members[1]!.seriesId, null);
    assert.equal(snapshot.failures, 1);
    assert.equal(snapshot.sourceCount, 3);
    assertNoIntermediateRanking(f, 3);
    f.gates[2]!.resolve(bars(200));
    const report = await running;
    assert.equal(report!.results.length, 3);
    assert.equal(f.state.getRound()!.status, 'partial');
    assert.equal(f.state.getRound()!.coverage.r16.eligible, 3);
    assert.equal(f.state.getRound()!.coverage.r16.available, 2);
    assert.equal(f.state.getRpsRound()!.members.length, 3);
    assert.equal(f.notifications.length, 3);
  } finally {
    for (const gate of f.gates) gate.resolve(bars());
    await running;
  }
});

test('畸形地址跳过后也持久化error，后续请求等待时页面可见完整成员进度', async (t) => {
  const f = fixture(t, ['0x123', 'a']);
  const running = f.scheduler.runOnce(now);
  try {
    await f.entered[0]!.promise;
    const snapshot = f.state.getRound()!;
    assert.equal(snapshot.members[0]!.pool.ca, '0x123');
    assert.equal(snapshot.members[0]!.klineStatus, 'error');
    assert.equal(snapshot.members[0]!.seriesId, null);
    assert.deepEqual(f.requests, ['a']);
    assertNoIntermediateRanking(f, 2);
    f.gates[0]!.resolve(bars());
    await running;
  } finally {
    for (const gate of f.gates) gate.resolve(bars());
    await running;
  }
});

test('读取新观察池期间保留资产列表，但旧分数仅保存在独立展示缓存', async (t) => {
  const f = fixture(t, ['a', 'b'], true);
  const pool = createPoolStore(f.db);
  pool.upsertPool([poolItem('a')], now - INTERVAL_MS['1h']);
  const old = initialRound(f.cfg, now - INTERVAL_MS['1h']);
  old.status = 'complete';
  old.completedAt = now - INTERVAL_MS['1h'] + 1000;
  old.boardComplete = true;
  old.sourceCount = 1;
  old.members = [pendingMember(pool.getPoolItem('a')!, 1)];
  old.members[0]!.seriesId = 'previous-series';
  old.members[0]!.qualified = true;
  old.members[0]!.rpsScores.r16 = 99;
  old.members[0]!.rpsBounds = { r16: { lower: 99, upper: 99, status: 'exact' }, r56: null, r96: null, r288: null, r672: null };
  old.coverage.r16 = { eligible: 1, available: 1, complete: true, source: 'kline' };
  // 模拟升级前只有last_round；启动写入必须先保存这个已完成结果。
  f.db.prepare('INSERT INTO runtime_state (key, payload, updated_at) VALUES (?, ?, ?)').run('last_round', JSON.stringify(old), old.completedAt);
  const running = f.scheduler.runOnce(now);
  try {
    await f.boardStarted.promise;
    assert.equal(f.state.getRound()!.boardComplete, false);
    assert.equal(f.state.getRound()!.members[0]!.pool.ca, 'a');
    assert.equal(f.state.getRound()!.members[0]!.qualified, false);
    assertNoIntermediateRanking(f, 1);
    assert.deepEqual(f.state.getRpsRound(), old);
    f.board.resolve();
    await f.entered[0]!.promise;
    assert.equal(f.state.getRound()!.boardComplete, true);
    assertNoIntermediateRanking(f, 2);
    assert.deepEqual(f.state.getRpsRound(), old);
    f.gates[0]!.resolve(bars());
    await f.entered[1]!.promise;
    assertNoIntermediateRanking(f, 2);
    assert.deepEqual(f.state.getRpsRound(), old);
    f.gates[1]!.resolve(bars(200));
    await running;
    assert.equal(f.state.getRpsRound()!.startedAt, now);
    assert.equal(f.state.getRpsRound()!.members.length, 2);
  } finally {
    f.board.resolve();
    for (const gate of f.gates) gate.resolve(bars());
    await running;
  }
});
