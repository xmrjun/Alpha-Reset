import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { loadStrategy } from '../../src/config/strategy.js';
import { INTERVAL_MS, emptyScores } from '../../src/market.js';
import type { Notification } from '../../src/notify/telegram.js';
import { createScheduler } from '../../src/scheduler/main.js';
import { createQuotaGuard } from '../../src/scheduler/quota.js';
import { openDatabase } from '../../src/store/db.js';
import { createRuntimeStore } from '../../src/store/runtime.js';
import { createSeriesStore } from '../../src/store/series.js';
import type { Candle, DexSnapshot } from '../../src/types.js';
import { boardPoolItem, candle, SAMPLE_STRATEGY } from '../helpers.js';

const T = 100 * INTERVAL_MS['1d'];
const step = INTERVAL_MS['15m'];
function deferred<V>() {
  let resolve!: (value: V | PromiseLike<V>) => void;
  const promise = new Promise<V>((done) => { resolve = done; });
  return { promise, resolve };
}
function history(until: number, scale = 1): Candle[] {
  return Array.from({ length: 800 }, (_, i) => candle(until - (800 - i) * step, 100 + i * scale));
}
function fixture(t: TestContext, addresses = ['a', 'b', 'c']) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  cfg.a4_rps.minRanked = 2;
  let now = T;
  const clock = () => now;
  const quota = createQuotaGuard(db, cfg, clock);
  const state = createRuntimeStore(db, clock);
  const series = createSeriesStore(db);
  const notifications: Notification[] = [];
  let calls = 0;
  const client = {
    async getTokenUsage() { calls++; return { usedToday: 0, remainingToday: 10_500, dailyLimit: 10_500 }; },
    async getBoardSummary() { calls++; return addresses.map((ca, i) => boardPoolItem(ca, { totalMentions: addresses.length - i })); },
    async getDexScreener(ca: string): Promise<DexSnapshot> { calls++; return { pairAddress: 'pool-' + ca, chainId: 'solana',
      priceUsd: 1, marketCap: 100_000, liquidityUsd: 50_000, pairCreatedAt: T - 60 * INTERVAL_MS['1d'],
      priceChange: { m5: null, h1: null, h6: null, h24: 100 } }; },
    async getKline() { return assert.fail('禁止回退无来源 K 线'); },
  };
  const source = { async getCandles15m(_network: string, _pool: string, _limit: number, ca?: string): Promise<Candle[]> {
    calls++; return history(Math.floor(now / step) * step, addresses.indexOf(ca ?? '') + 1);
  } };
  const notifier = { async notify(notification: Notification) { notifications.push(notification); return { tags: notification.tags, messages: 0 }; } };
  const scheduler = createScheduler({ db, cfg, quota, client, klineSource: source, notifier, clock, log: () => {} });
  return { db, cfg, state, series, scheduler, source, notifier, notifications, addresses, client,
    setNow(value: number) { now = value; }, calls: () => calls };
}

test('连续采集只入库，不覆盖评分、不记录规则时刻或发送通知', async (t) => {
  const f = fixture(t);
  const report = await f.scheduler.collectOnce(T);
  assert.equal(report!.results.length, 0);
  assert.equal(f.state.getCollectionRound()!.status, 'complete');
  assert.equal(f.state.getObservationRound()!.members.length, 3);
  assert.equal(f.state.getRound(), null);
  assert.equal(f.state.getRpsRound(), null);
  assert.equal(f.notifications.length, 0);
  for (const member of f.state.getCollectionRound()!.members) {
    assert.equal(f.series.getCandles(member.seriesId!, '15m').length, 800);
    assert.deepEqual(f.series.getMoments(member.seriesId!), []);
    assert.deepEqual(member.rpsScores, emptyScores());
  }
  const before = f.calls();
  assert.equal((await f.scheduler.calculateAt(T))!.results.length, 3);
  assert.equal(f.calls(), before, '计算不得调用任何行情或观察池 API');
  assert.equal(f.state.getRound()!.coverage.r16.available, 3);
  assert.equal(f.state.getRound()!.rpsRevision, 1);
});

test('HTTP 等待期间独立计算全池，迟到端点修订同一 T，采集进度不覆盖结果', async (t) => {
  const f = fixture(t);
  const secondEntered = deferred<void>();
  const releaseSecond = deferred<Candle[]>();
  const original = f.source.getCandles15m;
  f.source.getCandles15m = async (...args) => {
    if (args[3] === 'b') { secondEntered.resolve(); return releaseSecond.promise; }
    return original(...args);
  };
  const collecting = f.scheduler.collectOnce(T);
  try {
    await secondEntered.promise;
    assert.equal(await f.scheduler.collectOnce(T), null, '采集必须串行');
    assert.equal(f.state.getCollectionRound()!.status, 'running');
    assert.equal((await f.scheduler.calculateAt(T))!.results.length, 3);
    const first = f.state.getRound()!;
    assert.equal(first.coverage.r16.eligible, 3);
    assert.equal(first.coverage.r16.available, 1);
    assert.equal(first.startedAt, T);
    assert.equal(first.rpsRevision, 1);
    assert.equal(first.members[0]!.rpsScores.r16, null);
    assert.ok(first.members[0]!.rpsDisplayBounds!.r16);
    assert.ok(first.members.every((member) => !member.result!.reasons.a4));
    assert.equal(await f.scheduler.calculateAt(T), null, '相同端点不重复评分/通知');
    releaseSecond.resolve(history(T, 2));
    await collecting;
    assert.deepEqual(f.state.getRound(), first, 'collector 完成不覆盖已发布评分');
    f.setNow(T + 10_000);
    assert.equal((await f.scheduler.calculateAt(T))!.results.length, 3);
    const revised = f.state.getRound()!;
    assert.equal(revised.startedAt, T);
    assert.equal(revised.completedAt, T + 10_000);
    assert.equal(revised.rpsRevision, 2);
    assert.equal(revised.coverage.r16.available, 3);
    assert.equal(revised.coverage.r16.complete, true);
    assert.equal(f.notifications.length, 6);
    const seriesId = revised.members[0]!.seriesId!;
    f.series.upsertCandles(seriesId, '15m', [candle(T, 9999)]);
    assert.equal(await f.scheduler.calculateAt(T), null, 'T 后的数据不能改变 T 的排名');
    assert.equal(f.notifications.length, 6);
  } finally { releaseSecond.resolve(history(T, 2)); await collecting; }
});

test('连续采集逐请求取闭合时钟，跨界响应不冒充已收盘，后续成员接纳新收盘', async (t) => {
  const f = fixture(t, ['a', 'b']);
  f.source.getCandles15m = async () => {
    f.setNow(T + step);
    return [candle(T - step, 100), candle(T, 200), candle(T + step, 300)];
  };
  await f.scheduler.collectOnce(T);
  const members = f.state.getCollectionRound()!.members;
  const firstId = members.find((member) => member.pool.ca === 'a')!.seriesId!;
  const secondId = members.find((member) => member.pool.ca === 'b')!.seriesId!;
  assert.deepEqual(f.series.getCandles(firstId, '15m').map((bar) => bar.openTime), [T - step], '请求跨界不能确认请求前未闭合的快照');
  assert.deepEqual(f.series.getCandles(secondId, '15m').map((bar) => bar.openTime), [T, T - step], '后续请求不能继续受整轮startedAt限制');
  f.source.getCandles15m = async () => { throw new Error('offline'); };
  f.setNow(T + 2 * step);
  await f.scheduler.collectOnce(T + 2 * step);
  assert.equal(f.series.getCandles(secondId, '15m').some((bar) => bar.openTime === T + step), false);
  await f.scheduler.calculateAt(T + step);
  assert.equal(f.state.getRound()!.coverage.r16.missingCurrent, 1, '当前采集失败不能抹掉 b 已验证的精确端点');
});

test('新时点无端点时只发布等待状态，保留旧展示值并禁止旧 RPS 进入规则', async (t) => {
  const f = fixture(t);
  await f.scheduler.collectOnce(T);
  await f.scheduler.calculateAt(T);
  const old = f.state.getRpsRound()!;
  f.notifications.length = 0;
  f.setNow(T + 2 * step);
  await f.scheduler.calculateAt(T + 2 * step);
  const waiting = f.state.getRound()!;
  assert.equal(waiting.startedAt, T + 2 * step);
  assert.equal(waiting.coverage.r16.available, 0);
  assert.equal(waiting.coverage.r16.missingCurrent, 3);
  assert.deepEqual(f.state.getRpsRound(), old);
  assert.ok(waiting.members.every((member) => member.rpsScores.r16 === null && member.rpsDisplayBounds!.r16 === null));
  assert.ok(f.notifications.every((notification) => notification.tags.length === 0 && notification.rpsScores.r16 === null));
});

test('同一 T 固定完整成员集合，重启继续去重，下一时点接纳新池', async (t) => {
  const f = fixture(t);
  await f.scheduler.collectOnce(T);
  await f.scheduler.calculateAt(T);
  f.addresses.splice(0, f.addresses.length, 'a');
  await f.scheduler.collectOnce(T);
  assert.equal(f.state.getObservationRound()!.members.length, 1);
  assert.equal(await f.scheduler.calculateAt(T), null);
  assert.equal(f.state.getRound()!.members.length, 3);
  const restarted = createScheduler({ db: f.db, cfg: f.cfg, quota: createQuotaGuard(f.db, f.cfg, () => T),
    client: f.client, klineSource: f.source, notifier: f.notifier, clock: () => T, log: () => {} });
  assert.equal(await restarted.calculateAt(T), null, '输入指纹持久化跨重启去重');
  f.setNow(T + 2 * step);
  await f.scheduler.calculateAt(T + 2 * step);
  assert.equal(f.state.getRound()!.members.length, 1);
});

test('评分发布事务失败回滚所有新时刻与评分缓存，不发送通知', async (t) => {
  const f = fixture(t);
  await f.scheduler.collectOnce(T);
  f.db.exec(`CREATE TEMP TRIGGER reject_score BEFORE INSERT ON runtime_state
    WHEN NEW.key = 'last_round' BEGIN SELECT RAISE(ABORT, 'test rollback'); END;`);
  assert.equal(await f.scheduler.calculateAt(T), null);
  assert.equal(f.state.getRound(), null);
  assert.equal(f.state.getRpsRound(), null);
  assert.equal(f.notifications.length, 0);
  for (const member of f.state.getObservationRound()!.members) assert.deepEqual(f.series.getMoments(member.seriesId!), []);
});

test('通知尚未完成时计算锁拒绝重入，行情采集仍可独立进行', async (t) => {
  const f = fixture(t, ['a']);
  await f.scheduler.collectOnce(T);
  const entered = deferred<void>();
  const release = deferred<void>();
  f.notifier.notify = async (notification) => {
    entered.resolve(); await release.promise;
    return { tags: notification.tags, messages: 0 };
  };
  const calculation = f.scheduler.calculateAt(T);
  try {
    await entered.promise;
    assert.equal(await f.scheduler.calculateAt(T), null);
    assert.equal((await f.scheduler.collectOnce(T))!.poolComplete, true);
    assert.equal(f.state.getRound()!.startedAt, T);
    assert.equal(f.state.getRound()!.status, 'partial');
  } finally { release.resolve(); await calculation; }
});


test('仅同配置 v1 完整池可立即升级重算，旧 running 评分和系列声明不能被信任', async (t) => {
  const f = fixture(t);
  await f.scheduler.collectOnce(T);
  const previous = f.state.getObservationRound()!;
  previous.strategyKey = createHash('sha256').update('market-contract-v1:').update(JSON.stringify(f.cfg)).digest('hex');
  previous.status = 'running'; previous.completedAt = null;
  for (const member of previous.members) { member.seriesId = null; member.rpsScores.r16 = 99; }
  f.db.prepare("DELETE FROM runtime_state WHERE key IN ('collection_round', 'observation_round')").run();
  f.db.prepare('INSERT INTO runtime_state (key, payload, updated_at) VALUES (?, ?, ?)').run('last_round', JSON.stringify(previous), T);
  const before = f.calls();
  assert.equal((await f.scheduler.calculateAt(T))!.results.length, 3);
  assert.equal(f.calls(), before);
  const current = f.state.getRound()!;
  assert.notEqual(current.strategyKey, previous.strategyKey);
  assert.equal(current.coverage.r16.available, 3);
  assert.ok(current.members.every((member) => typeof member.seriesId === 'string' && member.rpsScores.r16 !== 99));
  const changedCfg = structuredClone(f.cfg);
  changedCfg.observeGroups = ['different-observation-scope'];
  const changed = createScheduler({ db: f.db, cfg: changedCfg, quota: createQuotaGuard(f.db, changedCfg, () => T),
    client: f.client, klineSource: f.source, notifier: f.notifier, clock: () => T, log: () => {} });
  assert.equal(await changed.calculateAt(T), null, '池筛选配置变化不得认领旧池');
});
