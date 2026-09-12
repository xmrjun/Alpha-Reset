import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test, type TestContext } from 'node:test';
import { ErwaClient, ErwaError, type ErwaErrorCode } from '../../src/api/erwa.js';
import { openDatabase } from '../../src/store/db.js';
import { createCandleStore } from '../../src/store/candles.js';
import { createUsageStore } from '../../src/store/usage.js';
import type { Range } from '../../src/types.js';

const usage = { used_today: 100, remaining_today: 10_400, daily_limit: 10_500 };
const rawCandle = { open_time: 0, open: 10, high: 12, low: 9, close: 11, volume: 100 };
const kline = { ca: 'test-ca', range: '24h', interval: '15m', status: 'ok', candles: [rawCandle] };
const makeClient = (onCall?: () => void) => new ErwaClient({ baseUrl: 'https://example.test',
  token: 'fake-api-secret', ...(onCall ? { onCall } : {}) });
const hasCode = (code: ErwaErrorCode) => (error: unknown) => error instanceof ErwaError && error.code === code;

function fastTimers(t: TestContext): number[] {
  const delays: number[] = [];
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    delays.push(ms ?? 0);
    return original(fn, 0, ...args);
  }) as typeof setTimeout);
  return delays;
}

test('观察组参数编码、认证头和字段映射，丢弃多余字段', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    assert.equal(input.pathname, '/api/v1/group_ca/board/summary');
    assert.equal(input.searchParams.get('group_name'), '示例群组一');
    assert.equal(input.searchParams.get('days'), '365');
    assert.equal(input.searchParams.get('limit'), '200');
    assert.equal(new Headers(init.headers).get('Authorization') === 'Bearer fake-api-secret', true);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({ cas: [{ ca: 'test-ca', symbol: 'TEST', chain: 'solana', market_cap: 100_000,
      liquidity: 50_000, volume_24h: 0, group_name: '示例群组一', latest_mention_time: 1_000, total_mentions: 7,
      unrelated: 'discard-me' }, { ca: 'new-ca' }] });
  });
  assert.deepEqual(await makeClient(() => calls++).getBoardSummary({ groupName: '示例群组一', days: 365, limit: 200 }), [
    { ca: 'test-ca', symbol: 'TEST', chain: 'solana', marketCap: 100_000, liquidity: 50_000,
      volume24h: 0, groupName: '示例群组一', latestMentionTime: 1_000, totalMentions: 7 },
    { ca: 'new-ca', symbol: null, chain: null, marketCap: null, liquidity: null,
      volume24h: null, groupName: null, latestMentionTime: null, totalMentions: null },
  ]);
  assert.equal(calls, 1);
});

test('观察组可接受带时区 ISO 提及时间，默认 days/limit 与 API 一致', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    assert.equal(url.searchParams.get('days'), '1');
    assert.equal(url.searchParams.get('limit'), '60');
    return Response.json({ cas: [{ ca: 'a', latest_mention_time: '2026-09-11T12:00:00+08:00' }] });
  });
  const items = await makeClient().getBoardSummary({ groupName: '示例群组二' });
  assert.equal(items[0]!.latestMentionTime, Date.parse('2026-09-11T04:00:00Z'));
});

test('K 线升序、去重和 OHLCV 映射', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...kline, candles: [
    { ...rawCandle, open_time: 900_000 }, rawCandle, { ...rawCandle, close: 12 },
  ] }));
  const result = await makeClient().getKline('test-ca', '24h');
  assert.deepEqual(result, { interval: '15m', status: 'ok', candles: [
    { openTime: 0, open: 10, high: 12, low: 9, close: 12, volume: 100 },
    { openTime: 900_000, open: 10, high: 12, low: 9, close: 11, volume: 100 },
  ] });
});

test('线上市值格式：优先精确最新市值，备用 K/M/B 格式严格解析', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ cas: [
    { ca: 'a', market_cap: '31.2M', latest_market_cap: 31_234_567,
      latest_mention_time: '2026-09-11T12:00:00' },
    { ca: 'b', market_cap: '$50.5K' }, { ca: 'c', market_cap: '1.2B' },
    { ca: 'd', market_cap: '1000' }, { ca: 'e', market_cap: null },
    { ca: 'f', market_cap: '1M', latest_market_cap: 0 },
  ] }));
  const items = await makeClient().getBoardSummary({ groupName: '示例群组一' });
  assert.deepEqual(items.map((item) => item.marketCap), [31_234_567, 50_500, 1_200_000_000, 1000, null, 0]);
  // 上游的无时区 ISO 时间按 UTC 解析（时区已实测确认，见 docs/02）
  assert.equal(items[0]!.latestMentionTime, Date.parse('2026-09-11T12:00:00Z'));
});

test('非法市值字符串和提及时间不能被隐式转成零或无效毫秒值', async (t) => {
  fastTimers(t);
  let row: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ cas: [row] }));
  const client = makeClient();
  for (const invalid of [{ market_cap: '' }, { market_cap: '12oops' }, { market_cap: 'Infinity' },
    { market_cap: true }, { latest_mention_time: 'yesterday' }]) {
    row = { ca: 'a', ...invalid };
    await assert.rejects(client.getBoardSummary({ groupName: '猫' }), hasCode('ERWA_VALIDATION'));
  }
});

test('四个 range 只能对应契约周期，合法空窗口可返回', async (t) => {
  const ranges = { '24h': '15m', '7d': '1h', '30d': '4h', '90d': '1d' } as const;
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    const range = url.searchParams.get('range') as Range;
    return Response.json({ ...kline, range, interval: ranges[range], candles: [] });
  });
  for (const range of Object.keys(ranges) as Range[]) {
    assert.deepEqual(await makeClient().getKline('test-ca', range), {
      interval: ranges[range], status: 'ok', candles: [],
    });
  }
});

test('配额响应只返回三个计数，机密额外字段不透传', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...usage, token: 'fake-api-secret' }));
  const client = makeClient();
  assert.deepEqual(await client.getTokenUsage(), { usedToday: 100, remainingToday: 10_400, dailyLimit: 10_500 });
  assert.doesNotMatch(inspect(client), /fake-api-secret/);
  assert.doesNotMatch(JSON.stringify(client), /fake-api-secret/);
});

test('5xx 指数退避最多重试 3 次，每次真实请求都计入配额', async (t) => {
  const delays = fastTimers(t);
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const store = createUsageStore(db);
  let attempt = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    attempt++;
    // 429 走持久化冷却而非重试（见 AGENTS.md），故重试路径只用 5xx
    return attempt < 4 ? new Response('ignored', { status: 503 }) : Response.json(usage);
  });
  await makeClient(() => store.incrementUsage('2026-09-11', 100)).getTokenUsage();
  assert.equal(attempt, 4);
  assert.equal(store.getUsage('2026-09-11')!.calls, 4);
  assert.deepEqual(delays.filter((delay) => delay >= 500), [500, 1000, 2000]);
});

test('重试耗尽后抛出可识别 HTTP 错误，不回显服务端内容', async (t) => {
  fastTimers(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response('fake-api-secret', { status: 500 }));
  await assert.rejects(makeClient(() => calls++).getTokenUsage(), (error: unknown) => {
    assert.ok(error instanceof ErwaError);
    assert.equal(error.code, 'ERWA_HTTP');
    assert.equal(error.httpStatus, 500);
    assert.doesNotMatch(inspect(error), /fake-api-secret/);
    return true;
  });
  assert.equal(calls, 4);
});

for (const status of [400, 401, 403, 404, 422]) {
  test(`HTTP ${status} 不重试`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => new Response('ignored', { status }));
    await assert.rejects(makeClient(() => calls++).getTokenUsage(), hasCode('ERWA_HTTP'));
    assert.equal(calls, 1);
  });
}

test('业务非 ok 状态抛识别错误，不静默返回空数组或重试', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'unavailable', detail: 'fake-api-secret' }));
  const client = makeClient(() => calls++);
  await assert.rejects(client.getKline('test-ca', '24h'), hasCode('ERWA_STATUS'));
  assert.equal(calls, 1);
});

test('所有端点均验证业务状态和响应类型', async (t) => {
  fastTimers(t);
  let response: unknown = { status: 'error', cas: [] };
  t.mock.method(globalThis, 'fetch', async () => Response.json(response));
  const client = makeClient();
  await assert.rejects(client.getBoardSummary({ groupName: '示例群组三' }), hasCode('ERWA_STATUS'));
  response = { status: 'error', ...usage };
  await assert.rejects(client.getTokenUsage(), hasCode('ERWA_STATUS'));
  response = { cas: [{ ca: 'a', market_cap: 'invalid-secret' }] };
  await assert.rejects(client.getBoardSummary({ groupName: '示例群组三' }), hasCode('ERWA_VALIDATION'));
  response = { ...usage, used_today: -1 };
  await assert.rejects(client.getTokenUsage(), hasCode('ERWA_VALIDATION'));
  response = [];
  await assert.rejects(client.getTokenUsage(), hasCode('ERWA_VALIDATION'));
});

test('非法 K 线或标的/周期错误在入库前被拦截', async (t) => {
  fastTimers(t);
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const store = createCandleStore(db);
  let response: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(response));
  const client = makeClient();
  for (const invalid of [
    { ...kline, ca: 'wrong-ca' }, { ...kline, range: '7d' }, { ...kline, interval: '1h' },
    { ...kline, status: undefined }, { ...kline, candles: [{ ...rawCandle, high: 5 }] },
    { ...kline, candles: [{ ...rawCandle, close: '11' }] },
    { ...kline, candles: [{ ...rawCandle, volume: -1 }] },
    { ...kline, candles: [{ ...rawCandle, open_time: 1 }] },
  ]) {
    response = invalid;
    await assert.rejects(async () => {
      const data = await client.getKline('test-ca', '24h');
      store.upsertCandles('test-ca', data.interval, data.candles);
    }, hasCode('ERWA_VALIDATION'));
  }
  assert.deepEqual(store.getCandles('test-ca', '15m'), []);
  response = kline;
  const valid = await client.getKline('test-ca', '24h');
  store.upsertCandles('test-ca', valid.interval, valid.candles);
  assert.equal(store.getCandles('test-ca', '15m').length, 1);
});

test('非 JSON / 网络失败不泄露底层错误，也不重试', async (t) => {
  let calls = 0;
  const stub = t.mock.method(globalThis, 'fetch', async (): Promise<Response> => {
    throw new Error('fake-api-secret');
  });
  await assert.rejects(makeClient(() => calls++).getTokenUsage(), (error: unknown) => {
    assert.ok(hasCode('ERWA_NETWORK')(error));
    assert.doesNotMatch(inspect(error), /fake-api-secret/);
    return true;
  });
  stub.mock.mockImplementation(async () => new Response('fake-api-secret'));
  await assert.rejects(makeClient(() => calls++).getTokenUsage(), hasCode('ERWA_VALIDATION'));
  assert.equal(calls, 2);
});

test('请求串行限流，失败后队列仍可继续', async (t) => {
  const delays = fastTimers(t);
  let active = 0;
  let peak = 0;
  let index = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    active++;
    peak = Math.max(active, peak);
    await Promise.resolve();
    active--;
    return ++index === 1 ? new Response('', { status: 403 }) : Response.json(usage);
  });
  const client = makeClient();
  const results = await Promise.allSettled([client.getTokenUsage(), client.getTokenUsage(), client.getTokenUsage()]);
  assert.deepEqual(results.map((result) => result.status), ['rejected', 'fulfilled', 'fulfilled']);
  assert.equal(peak, 1);
  assert.equal(delays.length, 2);
  assert.ok(delays.every((delay) => delay > 0 && delay <= 200));
});

test('limit 超过 200 被夹紧而非报错——上游超限会静默返回 0 条', async (t) => {
  let sent: string | null = null;
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    sent = url.searchParams.get('limit');
    return Response.json({ cas: [] });
  });
  await makeClient().getBoardSummary({ groupName: '猫', limit: 999 });
  assert.equal(sent, '200');
});

test('非法客户端/查询参数本地拒绝，不消耗请求', async (t) => {
  const stub = t.mock.method(globalThis, 'fetch', async () => Response.json(usage));
  assert.throws(() => new ErwaClient({ baseUrl: 'invalid-secret', token: 'fake' }), hasCode('ERWA_CONFIG'));
  assert.throws(() => new ErwaClient({ baseUrl: 'https://user:password@example.test', token: 'fake' }), hasCode('ERWA_CONFIG'));
  const client = makeClient();
  await assert.rejects(client.getBoardSummary({ groupName: '', limit: 200 }), hasCode('ERWA_INPUT'));
  await assert.rejects(client.getKline('', '24h'), hasCode('ERWA_INPUT'));
  await assert.rejects(client.getKline('a', 'invalid' as Range), hasCode('ERWA_INPUT'));
  assert.equal(stub.mock.callCount(), 0);
});
