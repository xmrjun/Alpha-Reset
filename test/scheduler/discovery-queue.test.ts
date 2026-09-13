import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { GeckoTerminalError } from '../../src/api/geckoterminal.js';
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
const FIVE_MINUTES = 5 * 60_000;
function deferred<V>() {
  let resolve!: (value: V | PromiseLike<V>) => void;
  const promise = new Promise<V>((done) => { resolve = done; });
  return { promise, resolve };
}
function history(until = T): Candle[] {
  return Array.from({ length: 800 }, (_, i) => candle(until - (800 - i) * INTERVAL_MS['15m'], 100 + i));
}
function dex(ca: string): DexSnapshot {
  return { pairAddress: 'pool-' + ca, chainId: 'solana', priceUsd: 1, marketCap: 100_000, liquidityUsd: 50_000,
    pairCreatedAt: T - 60 * INTERVAL_MS['1d'], priceChange: { m5: null, h1: null, h6: null, h24: null } };
}
function fixture(t: TestContext, addresses = ['a', 'b', 'c']) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  cfg.pool.maxCandidates = null; cfg.pool.refreshMinutes = 5;
  let now = T;
  const clock = () => now;
  const quota = createQuotaGuard(db, cfg, clock);
  const state = createRuntimeStore(db, clock);
  const sourceRequests: string[] = [];
  const dexRequests: string[][] = [];
  const erwaRequests: string[] = [];
  const notifications: Notification[] = [];
  const marketUpdates: number[] = [];
  const logs: Record<string, unknown>[] = [];
  const client = {
    async getTokenUsage() { erwaRequests.push('usage'); const usage = quota.state(clock());
      return { usedToday: usage.used, remainingToday: usage.limit - usage.used, dailyLimit: usage.limit }; },
    async getBoardSummary() { erwaRequests.push('board'); return addresses.map((ca, i) => boardPoolItem(ca, { totalMentions: addresses.length - i })); },
    async getDexScreener(): Promise<DexSnapshot> { return assert.fail('生产发现应使用官方批量 Dex'); },
    async getKline() { return assert.fail('行情不得回退二娃'); },
  };
  const dexBatch = { async getAll(items: { ca: string; chain: string | null }[]) {
    dexRequests.push(items.map((item) => item.ca)); return new Map(items.map((item) => [item.ca, dex(item.ca)]));
  } };
  const source = { async getCandles15m(_network: string, _pool: string, _limit: number, ca?: string): Promise<Candle[]> {
    sourceRequests.push(ca!); return history(Math.floor(clock() / INTERVAL_MS['15m']) * INTERVAL_MS['15m']);
  } };
  const notifier = { async notify(notification: Notification) { notifications.push(notification); return { tags: notification.tags, messages: 0 }; } };
  const make = () => createScheduler({ db, cfg, quota, client, dexBatch, klineSource: source, notifier, clock,
    onMarketData: () => { marketUpdates.push(sourceRequests.length); },
    log: (event) => logs.push(event) });
  return { db, cfg, quota, state, client, dexBatch, source, sourceRequests, dexRequests, erwaRequests,
    notifications, marketUpdates, logs, addresses, make, setNow(value: number) { now = value; } };
}

test('发现完整池超过132，后续刷新复用已验证Dex和上市日期，不发K线或通知', async (t) => {
  const f = fixture(t, Array.from({ length: 160 }, (_, i) => 'ca-' + i));
  const scheduler = f.make();
  const first = await scheduler.discoverOnce(T);
  assert.equal(first!.poolSize, 160);
  const observed = f.state.getObservationRound()!;
  assert.equal(observed.sourceCount, 160);
  assert.equal(observed.members.length, 160);
  assert.equal(observed.observedAt, T);
  assert.equal(observed.addedCount, 160);
  assert.equal(observed.removedCount, 0);
  assert.equal(f.state.getDiscoveryRound()!.status, 'complete');
  assert.equal(f.dexRequests.length, 1);
  assert.equal(f.dexRequests[0]!.length, 160);
  assert.equal(f.sourceRequests.length, 0);
  assert.equal(f.notifications.length, 0);
  f.setNow(T + FIVE_MINUTES);
  await scheduler.discoverOnce(T + FIVE_MINUTES);
  assert.equal(f.dexRequests.length, 1, '还未首次采集成功也可复用已验证的首次Dex池身份');
  assert.equal(f.state.getObservationRound()!.addedCount, 0);
  assert.equal(f.state.getObservationRound()!.observedAt, T + FIVE_MINUTES);
  assert.equal(f.erwaRequests.filter((request) => request === 'board').length, f.cfg.observeGroups.length * 2);
});

test('长行情请求不阻塞新发现，移出成员停止排队，旧采集进度不能覆盖新观察池', async (t) => {
  const f = fixture(t);
  const scheduler = f.make();
  await scheduler.discoverOnce(T);
  const entered = deferred<void>(); const release = deferred<Candle[]>();
  const original = f.source.getCandles15m;
  f.source.getCandles15m = async (...args) => {
    if (args[3] === 'a') { f.sourceRequests.push('a'); entered.resolve(); return release.promise; }
    return original(...args);
  };
  const collecting = scheduler.collectKnownPoolOnce(T);
  try {
    await entered.promise;
    assert.equal(await scheduler.collectKnownPoolOnce(T), null);
    f.addresses.splice(0, 3, 'b', 'c', 'd');
    f.setNow(T + FIVE_MINUTES);
    await scheduler.discoverOnce(T + FIVE_MINUTES);
    const next = f.state.getObservationRound()!;
    assert.deepEqual(next.members.map((member) => member.pool.ca), ['b', 'c', 'd']);
    assert.equal(next.addedCount, 1); assert.equal(next.removedCount, 1);
    assert.deepEqual(f.dexRequests.at(-1), ['d']);
    release.resolve(history());
    await collecting;
    assert.deepEqual(f.sourceRequests, ['a', 'b', 'c', 'd']);
    assert.deepEqual(f.state.getObservationRound(), next);
    assert.deepEqual(f.state.getCollectionRound()!.members.map((member) => member.pool.ca), ['b', 'c', 'd']);
    assert.equal(f.state.getCollectionRound()!.startedAt, T);
    assert.equal(f.notifications.length, 0);
  } finally { release.resolve(history()); await collecting; }
});

test('429尝试先持久移至队尾，冷却后重启从等待者续采，失败资产不会饿死队尾', async (t) => {
  const f = fixture(t);
  let scheduler = f.make();
  await scheduler.discoverOnce(T);
  const original = f.source.getCandles15m;
  let failed = false;
  f.source.getCandles15m = async (...args) => {
    if (!failed) { failed = true; f.sourceRequests.push(args[3]!);
      throw new GeckoTerminalError('GECKO_RATE_LIMIT', 'mock cooldown', 429, T + FIVE_MINUTES); }
    return original(...args);
  };
  const first = await scheduler.collectKnownPoolOnce(T);
  assert.equal(first!.halted, true);
  assert.deepEqual(f.sourceRequests, ['a']);
  const firstAttempt = f.state.getCollectionAttempt('solana', 'a')!;
  assert.equal(firstAttempt.attemptedAt, T);
  assert.ok(firstAttempt.sequence > f.state.getCollectionAttempt('solana', 'c')!.sequence);
  scheduler = f.make();
  await scheduler.collectKnownPoolOnce(T);
  assert.deepEqual(f.sourceRequests, ['a'], '冷却期间不得向下一CA试探请求');
  f.setNow(T + FIVE_MINUTES);
  await scheduler.collectKnownPoolOnce(T + FIVE_MINUTES);
  assert.deepEqual(f.sourceRequests, ['a', 'b', 'c', 'a']);
  assert.ok(f.state.getCollectionAttempt('solana', 'a')!.sequence > f.state.getCollectionAttempt('solana', 'c')!.sequence);
});

test('Gecko冷却仍发现新成员并读库算RPS，二娃冷却和配额不阻止已知池行情', async (t) => {
  const f = fixture(t);
  const scheduler = f.make();
  await scheduler.discoverOnce(T);
  await scheduler.collectKnownPoolOnce(T);
  f.state.geckoRateLimitStore.setUntil(T + 10 * FIVE_MINUTES);
  f.addresses.push('d'); f.setNow(T + FIVE_MINUTES);
  await scheduler.discoverOnce(T + FIVE_MINUTES);
  assert.equal(f.state.getObservationRound()!.members.length, 4);
  assert.equal((await scheduler.calculateAt(T))!.poolSize, 4);
  assert.equal(f.state.getRound()!.coverage.r16.available, 3);
  const before = f.erwaRequests.length;
  f.state.rateLimitStore.setUntil(T + 100 * FIVE_MINUTES);
  f.quota.sync(10_000, 10_500, T + FIVE_MINUTES);
  f.setNow(T + 11 * FIVE_MINUTES);
  const discovered = await scheduler.discoverOnce(T + 11 * FIVE_MINUTES);
  assert.equal(discovered!.halted, true);
  assert.equal(f.erwaRequests.length, before);
  const requests = f.sourceRequests.length;
  const collected = await scheduler.collectKnownPoolOnce(T + 11 * FIVE_MINUTES);
  assert.equal(collected!.halted, false);
  assert.equal(f.sourceRequests.length - requests, 4);
});

test('同T固定评分分母，下一评分时点纳入5分钟独立发现的新成员', async (t) => {
  const f = fixture(t, ['a', 'b']);
  const scheduler = f.make();
  await scheduler.discoverOnce(T); await scheduler.collectKnownPoolOnce(T); await scheduler.calculateAt(T);
  f.addresses.push('c'); f.setNow(T + FIVE_MINUTES);
  await scheduler.discoverOnce(T + FIVE_MINUTES); await scheduler.collectKnownPoolOnce(T + FIVE_MINUTES);
  assert.equal(await scheduler.calculateAt(T), null);
  assert.equal(f.state.getRound()!.members.length, 2);
  f.setNow(T + 30 * 60_000);
  await scheduler.calculateAt(T + 30 * 60_000);
  assert.equal(f.state.getRound()!.members.length, 3);
  assert.ok(f.state.getObservationRound()!.members.every((member) => JSON.stringify(member.rpsScores) === JSON.stringify(emptyScores())));
});

test('三群有一群发现失败保持上一完整池，不把部分来源或空池发布出去', async (t) => {
  const f = fixture(t);
  const scheduler = f.make();
  await scheduler.discoverOnce(T);
  const previous = f.state.getObservationRound();
  for (let failedGroup = 1; failedGroup <= f.cfg.observeGroups.length; failedGroup++) {
    let boards = 0;
    f.client.getBoardSummary = async () => { if (++boards === failedGroup) throw new Error('mock board failure'); return [boardPoolItem('new')]; };
    f.setNow(T + failedGroup * FIVE_MINUTES);
    const failed = await scheduler.discoverOnce(T + failedGroup * FIVE_MINUTES);
    assert.equal(failed!.poolComplete, false);
    assert.equal(f.state.getDiscoveryRound()!.status, 'failed');
    assert.deepEqual(f.state.getObservationRound(), previous);
  }
});

test('新成员Dex链不匹配不缓存上市日、不激活行情或回退其他来源', async (t) => {
  const f = fixture(t, ['a']);
  f.dexBatch.getAll = async () => new Map([['a', { ...dex('a'), chainId: 'ethereum' }]]);
  const scheduler = f.make();
  await scheduler.discoverOnce(T);
  assert.equal(f.state.getObservationRound()!.members[0]!.dexStatus, 'error');
  assert.equal(f.state.getListing('a', 'solana'), null);
  assert.equal(f.state.getListing('a', 'eth'), null);
  await scheduler.collectKnownPoolOnce(T);
  assert.equal(f.sourceRequests.length, 0);
  assert.equal(createSeriesStore(f.db).getActive('solana', 'a'), null);
  assert.equal(f.state.getCollectionAttempt('solana', 'a')!.attemptedAt, T);
});

test('已有固定池与日期无需每5分钟补查Dex，即使观察快照未保留Dex价格', async (t) => {
  const f = fixture(t, ['a']);
  const scheduler = f.make();
  await scheduler.discoverOnce(T); await scheduler.collectKnownPoolOnce(T);
  const previous = f.state.getObservationRound()!;
  previous.members[0]!.dex = null; previous.members[0]!.dexStatus = 'pending';
  f.state.saveObservationRound(previous);
  f.setNow(T + FIVE_MINUTES);
  await scheduler.discoverOnce(T + FIVE_MINUTES);
  assert.equal(f.dexRequests.length, 1);
  assert.equal(typeof f.state.getObservationRound()!.members[0]!.seriesId, 'string');
  assert.equal((await scheduler.collectKnownPoolOnce(T + FIVE_MINUTES))!.failures, 0);
});


test('新CA先作为pending成员发布，Dex确认后可加入仍在进行的长行情轮次', async (t) => {
  const f = fixture(t, ['a', 'b']);
  const scheduler = f.make();
  await scheduler.discoverOnce(T);
  const sourceEntered = deferred<void>(); const releaseSource = deferred<Candle[]>();
  const dexEntered = deferred<void>(); const releaseDex = deferred<Map<string, DexSnapshot>>();
  const original = f.source.getCandles15m;
  f.source.getCandles15m = async (...args) => {
    if (args[3] === 'a') { f.sourceRequests.push('a'); sourceEntered.resolve(); return releaseSource.promise; }
    return original(...args);
  };
  const collecting = scheduler.collectKnownPoolOnce(T);
  let discovering: ReturnType<typeof scheduler.discoverOnce> | undefined;
  try {
    await sourceEntered.promise;
    f.addresses.push('c'); f.setNow(T + FIVE_MINUTES);
    f.dexBatch.getAll = async () => { dexEntered.resolve(); return releaseDex.promise; };
    discovering = scheduler.discoverOnce(T + FIVE_MINUTES);
    await dexEntered.promise;
    assert.equal(await scheduler.discoverOnce(T + FIVE_MINUTES), null, '发现流程自身不能重入');
    const pending = f.state.getObservationRound()!.members.find((member) => member.pool.ca === 'c')!;
    assert.equal(pending.dexStatus, 'pending'); assert.equal(pending.seriesId, null);
    assert.equal(f.sourceRequests.includes('c'), false);
    releaseDex.resolve(new Map([['c', dex('c')]])); await discovering;
    releaseSource.resolve(history()); await collecting;
    assert.deepEqual(f.sourceRequests, ['a', 'b', 'c']);
    assert.equal(typeof createSeriesStore(f.db).getActive('solana', 'c')?.id, 'string');
  } finally { releaseDex.resolve(new Map([['c', dex('c')]])); releaseSource.resolve(history()); await discovering; await collecting; }
});

test('Gecko长轮每次成功入库即报告更新，不等待队尾HTTP也不从采集直接计算或通知', async (t) => {
  const f = fixture(t, ['a', 'b']);
  const scheduler = f.make();
  await scheduler.discoverOnce(T);
  const entered = deferred<void>(); const release = deferred<Candle[]>();
  const original = f.source.getCandles15m;
  f.source.getCandles15m = async (...args) => {
    if (args[3] === 'b') { f.sourceRequests.push('b'); entered.resolve(); return release.promise; }
    return original(...args);
  };
  const collecting = scheduler.collectKnownPoolOnce(T);
  try {
    await entered.promise;
    assert.deepEqual(f.marketUpdates, [1], '首个成员已入库即交给共享协调器');
    assert.equal(f.state.getRound(), null);
    assert.equal(f.notifications.length, 0);
  } finally { release.resolve(history(T)); await collecting; }
  assert.deepEqual(f.marketUpdates, [1, 2]);
  assert.equal(f.notifications.length, 0);
});
