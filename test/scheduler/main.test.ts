import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { loadStrategy } from '../../src/config/strategy.js';
import { createScheduler } from '../../src/scheduler/main.js';
import { createQuotaGuard, QuotaStopError, usageDate } from '../../src/scheduler/quota.js';
import { createNotifier, type Notification } from '../../src/notify/telegram.js';
import { openDatabase } from '../../src/store/db.js';
import { createPoolStore } from '../../src/store/pool.js';
import { createCandleStore } from '../../src/store/candles.js';
import { createUsageStore } from '../../src/store/usage.js';
import { HOUR_MS, INTERVAL_MS } from '../../src/market.js';
import type { DexSnapshot, Interval, Range } from '../../src/types.js';
import { boardPoolItem, candle, poolItem } from '../helpers.js';

const now = 100 * 24 * HOUR_MS;
function fixture(t: TestContext) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const cfg = loadStrategy();
  const requests: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const quota = createQuotaGuard(db, cfg, () => now);
  const intervals: Record<Range, Interval> = { '24h': '15m', '7d': '1h', '30d': '4h', '90d': '1d' };
  const client = {
    async getTokenUsage() { quota.onCall(); requests.push('usage'); return { usedToday: 0, remainingToday: 10_500, dailyLimit: 10_500 }; },
    async getBoardSummary() { quota.onCall(); requests.push('board'); return [boardPoolItem('a')]; },
    // DexScreener 免认证且不计配额，故不调 quota.onCall()
    async getDexScreener(ca: string): Promise<DexSnapshot> {
      requests.push('dex:' + ca);
      return { priceUsd: 1, marketCap: 1_000_000, liquidityUsd: 100_000,
        priceChange: { m5: 0, h1: 0, h6: 0, h24: 5 },
        pairCreatedAt: now - 60 * INTERVAL_MS['1d'] };
    },
    async getKline(ca: string, range: Range) {
      quota.onCall(); requests.push(`${ca}:${range}`);
      const interval = intervals[range];
      return { interval, status: 'ok', candles: Array.from({ length: 60 }, (_, i) =>
        candle(Math.floor(now / INTERVAL_MS[interval]) * INTERVAL_MS[interval] - (60 - i) * INTERVAL_MS[interval], 100 + i)) };
    },
  };
  const notifications: Notification[] = [];
  const realNotifier = createNotifier({ db, cfg, dryRun: true, publicSite: 'https://example.test',
    send: async () => { assert.fail('干跑不得推送'); }, log: () => {} });
  const notifier = { notify: async (input: Notification) => { notifications.push(input); return realNotifier.notify(input); } };
  const make = () => createScheduler({ db, cfg, client, quota, notifier, log: (event) => logs.push(event) });
  return { db, cfg, client, quota, requests, logs, notifications, make };
}

test('完整一轮合并三组同一 CA、累积四周期、记录时刻并逐 CA 打印判定', async (t) => {
  const f = fixture(t);
  const result = await f.make().runOnce(now);
  assert.equal(result!.poolSize, 1);
  assert.equal(result!.results.length, 1);
  assert.equal(result!.failures, 0);
  // 三层架构的调用顺序：board 建池 → dex 零配额筛选 → 仅对通过者拉 K 线
  assert.deepEqual(f.requests, [
    'usage',                      // 轮开始的配额检查
    'board', 'board', 'board',    // 第 1 层：三个观察组
    'usage',                      // 层间配额检查
    'dex:a',                      // 第 2 层：A1/A2 筛选，不计配额
    'usage',                      // 层间配额检查
    'a:24h', 'a:7d', 'a:30d',     // 第 3 层：只对通过筛选的 CA 拉 K 线
  ]);
  assert.equal(createCandleStore(f.db).getCandles('a', '15m').length, 60);
  assert.equal(createPoolStore(f.db).getPoolItem('a')!.groupName, f.cfg.observeGroups.join('、'));
  assert.equal(createPoolStore(f.db).getPoolItem('a')!.listedAt, now - 60 * INTERVAL_MS['1d']);
  assert.ok(f.logs.some((event) => event.event === 'evaluate'));
  assert.ok(result!.results[0]!.result.newMoments.length > 0);
  const snapshot = f.notifications[0]!.payload.indicators as Record<string, { rsi: number; volumeMa: number }>;
  assert.equal(snapshot['60m']!.rsi, 100);
  assert.equal(snapshot['60m']!.volumeMa, 100);
});

test('差异化刷新由配置轮数驱动，重跑不会清除历史 K 线', async (t) => {
  const f = fixture(t);
  const scheduler = f.make();
  await scheduler.runOnce(now);
  f.requests.length = 0;
  await scheduler.runOnce(now + HOUR_MS / 2);
  assert.deepEqual(f.requests, ['usage', 'board', 'board', 'board', 'usage', 'dex:a', 'usage', 'a:24h']);
  f.requests.length = 0;
  await scheduler.runOnce(now + HOUR_MS);
  assert.ok(f.requests.includes('a:7d'));
  assert.ok(!f.requests.includes('a:30d'));
  assert.equal(createCandleStore(f.db).getCandles('a', '15m').length, 60);
});

test('达到降级阈值只拉 24h，不拉高周期', async (t) => {
  const f = fixture(t);
  // 85% 触发降级；用现实额度使容量自检通过，否则池子会被判定为 0 个 CA
  f.quota.sync(8_925, 10_500, now);
  f.client.getTokenUsage = async () => { f.quota.onCall(); f.requests.push('usage'); return { usedToday: 8_925, remainingToday: 1_575, dailyLimit: 10_500 }; };
  const result = await f.make().runOnce(now);
  assert.equal(result!.degraded, true);
  // 降级后只保留 24h，7d/30d 被跳过
  assert.deepEqual(f.requests, ['usage', 'board', 'board', 'board', 'usage', 'dex:a', 'usage', 'a:24h']);
  assert.ok(!f.requests.includes('a:7d'));
  assert.ok(!f.requests.includes('a:30d'));
});

test('A1 查不到上市时间则跳过该 CA，不消耗行情配额', async (t) => {
  const f = fixture(t);
  // dex 不计配额，故照常调用；此处查不到上市时间
  f.client.getDexScreener = async (ca: string): Promise<DexSnapshot> => { f.requests.push('dex:' + ca);
    return { priceUsd: 1, marketCap: 1_000_000, liquidityUsd: 100_000,
      priceChange: { m5: 0, h1: 0, h6: 0, h24: 5 }, pairCreatedAt: null }; };
  const result = await f.make().runOnce(now);
  assert.equal(result!.results[0]!.result.reasons.a1, false);
  // 契约：A1 取不到上市时间必须跳过，不得默认通过，也不得为它拉 K 线
  assert.ok(!f.requests.some((r) => r.includes(':24h')));
  // 不回退到 firstSeenAt：那是本系统首次观测时间，冒充上市时间会让 A1 误判为通过
  assert.equal(createPoolStore(f.db).getPoolItem('a')!.listedAt, null);
});

test('本地已达停止阈值时零请求，轮中达到阈值也即时停止', async (t) => {
  const f = fixture(t);
  // 额度 4：usage(1) + board(3) 恰好触及 95% 停止线，用于验证"轮中达到阈值即时停止"
  f.quota.sync(0, 4, now);
  f.cfg.pool.maxCandidates = 0; // 该额度撑不起任何 CA，容量自检的正确结论就是 0
  f.client.getTokenUsage = async () => { f.quota.onCall(); f.requests.push('usage'); return { usedToday: 0, remainingToday: 4, dailyLimit: 4 }; };
  const result = await f.make().runOnce(now);
  assert.equal(result!.halted, true);
  assert.equal(f.requests.length, 4);
  const again = await f.make().runOnce(now);
  assert.equal(again!.halted, true);
  assert.equal(f.requests.length, 4); // 已 halted，第二轮零新请求
  assert.throws(() => f.quota.onCall(), QuotaStopError);
});

test('配额查询失败时停止，观察组失败时不给部分池算可触发的 RPS', async (t) => {
  const f = fixture(t);
  f.client.getTokenUsage = async () => { throw new Error('secret-not-for-log'); };
  const stopped = await f.make().runOnce(now);
  assert.equal(stopped!.halted, true);
  assert.equal(f.requests.length, 0);
  assert.doesNotMatch(JSON.stringify(f.logs), /secret-not-for-log/);
  f.client.getTokenUsage = async () => ({ usedToday: 0, remainingToday: 10_500, dailyLimit: 10_500 });
  let groups = 0;
  f.client.getBoardSummary = async () => { if (++groups === 2) throw new Error(); return [boardPoolItem('a')]; };
  const partial = await f.make().runOnce(now);
  assert.equal(partial!.poolComplete, false);
  // 观察组不完整时整轮中止，一个 CA 都不评估——比"用残缺池子算 RPS"更安全
  assert.equal(partial!.results.length, 0);
});

test('并发轮次不重入；API 配额按显式时区分日', async (t) => {
  const f = fixture(t);
  const scheduler = f.make();
  const result = await Promise.all([scheduler.runOnce(now), scheduler.runOnce(now)]);
  assert.equal(result[1], null);
  assert.equal(usageDate(Date.parse('2026-09-11T18:00:00Z'), 'Asia/Shanghai'), '2026-09-12');
  assert.equal(usageDate(Date.parse('2026-09-11T18:00:00Z')), '2026-09-11');
  // 三层架构下一轮计 9 次：usage×3（层间检查）+ board×3 + kline×3；dex 走官方端点不计配额
  assert.equal(createUsageStore(f.db).getUsage(usageDate(now))!.calls, 9);
});

test('24h 行情失败跳过该 CA 的高周期，错误 EVM 地址不消耗行情请求', async (t) => {
  const f = fixture(t);
  f.client.getBoardSummary = async () => [boardPoolItem('a'), boardPoolItem('0x123')];
  f.client.getKline = async (ca, range) => { f.requests.push(`${ca}:${range}`); throw new Error(); };
  const report = await f.make().runOnce(now);
  // 0x123 是残缺 EVM 地址，本地跳过，不发行情请求（dex 仍会查，因其不计配额）
  assert.deepEqual(f.requests, ['usage', 'usage', 'dex:0x123', 'dex:a', 'usage', 'a:24h']);
  // poolComplete 指观察池构建完整（三个群都取到），与行情是否拉到无关；
  // 行情失败体现在 failures 上，两者语义不同
  assert.equal(report!.poolComplete, true);
  assert.ok(report!.failures > 0);
  assert.ok(f.logs.some((entry) => entry.reason === 'malformed_evm_address'));
});
