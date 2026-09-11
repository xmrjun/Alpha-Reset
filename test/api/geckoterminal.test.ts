import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeckoTerminalClient, GeckoTerminalError } from '../../src/api/geckoterminal.js';

const body = (rows: number[][]) => Response.json({
  data: { attributes: { ohlcv_list: rows } },
});

// 上游按时间倒序返回，秒级时间戳
const sample = [
  [1_789_139_700, 2, 3, 1, 2.5, 100],
  [1_789_138_800, 1, 2, 0.5, 2, 50],
];

function client(t: { mock: { method: typeof import('node:test').mock.method } },
                impl: (url: URL) => Promise<Response>) {
  t.mock.method(globalThis, 'fetch', impl as unknown as typeof fetch);
  // 测试里不要真等限流间隔
  return new GeckoTerminalClient({ requestsPerMinute: 60_000, retryBaseMs: 1 });
}

test('K 线转为毫秒、升序，并过滤非法收盘价', async (t) => {
  let seen: URL | undefined;
  const gecko = client(t, async (url: URL) => {
    seen = url;
    return body([...sample, [1_789_137_900, 0, 0, 0, 0, 0]]);
  });
  const bars = await gecko.getCandles15m('robinhood', '0xpool');

  assert.equal(seen!.pathname, '/api/v2/networks/robinhood/pools/0xpool/ohlcv/minute');
  assert.equal(seen!.searchParams.get('aggregate'), '15');
  assert.equal(seen!.searchParams.get('limit'), '1000');

  assert.equal(bars.length, 2, 'close<=0 的 bar 应被剔除');
  assert.ok(bars[0]!.openTime < bars[1]!.openTime, '必须升序');
  assert.equal(bars[0]!.openTime, 1_789_138_800_000, '秒必须转成毫秒');
  assert.deepEqual(
    { open: bars[1]!.open, high: bars[1]!.high, low: bars[1]!.low, close: bars[1]!.close, volume: bars[1]!.volume },
    { open: 2, high: 3, low: 1, close: 2.5, volume: 100 },
  );
});

test('429 退避重试，重试成功则正常返回', async (t) => {
  let calls = 0;
  const gecko = client(t, async (_url: URL) => {
    calls++;
    return calls < 3 ? new Response('rate limited', { status: 429 }) : body(sample);
  });
  const bars = await gecko.getCandles15m('bsc', '0xpool');
  assert.equal(calls, 3);
  assert.equal(bars.length, 2);
});

test('持续 429 最终抛 GECKO_RATE_LIMIT，不静默返回空', async (t) => {
  const gecko = client(t, async (_url: URL) => new Response('rate limited', { status: 429 }));
  await assert.rejects(
    gecko.getCandles15m('bsc', '0xpool'),
    (error: unknown) => error instanceof GeckoTerminalError && error.code === 'GECKO_RATE_LIMIT',
  );
});

test('非法入参本地拒绝；4xx 与响应格式错误各有独立错误码', async (t) => {
  const gecko = client(t, async (_url: URL) => new Response('nope', { status: 404 }));
  await assert.rejects(gecko.getCandles15m('', '0xpool'),
    (e: unknown) => e instanceof GeckoTerminalError && e.code === 'GECKO_INPUT');
  await assert.rejects(gecko.getCandles15m('bsc', '  '),
    (e: unknown) => e instanceof GeckoTerminalError && e.code === 'GECKO_INPUT');
  await assert.rejects(gecko.getCandles15m('bsc', '0xpool'),
    (e: unknown) => e instanceof GeckoTerminalError && e.code === 'GECKO_HTTP');

  const bad = client(t, async (_url: URL) => Response.json({ data: { attributes: {} } }));
  await assert.rejects(bad.getCandles15m('bsc', '0xpool'),
    (e: unknown) => e instanceof GeckoTerminalError && e.code === 'GECKO_VALIDATION');
});

test('空列表返回空数组而非报错——上游对冷门池确实会返回空', async (t) => {
  const gecko = client(t, async (_url: URL) => body([]));
  assert.deepEqual(await gecko.getCandles15m('bsc', '0xpool'), []);
});
