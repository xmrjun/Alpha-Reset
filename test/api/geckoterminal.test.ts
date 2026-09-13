import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeckoTerminalClient, GeckoTerminalError } from '../../src/api/geckoterminal.js';
import { resolveGeckoNetwork } from '../../src/api/networks.js';

const body = (rows: number[][]) => Response.json({
  data: { attributes: { ohlcv_list: rows } },
});

// 上游按时间倒序返回，秒级时间戳
const sample = [
  [1_789_139_700, 2, 3, 1, 2.5, 100],
  [1_789_138_800, 1, 2, 0.5, 2, 50],
];

interface FakeClock { now: number; waits: number[] }

function client(t: { mock: { method: typeof import('node:test').mock.method } },
                impl: (url: URL) => Promise<Response>,
                opts: { time?: FakeClock; requestsPerMinute?: number; retryBaseMs?: number } = {}) {
  t.mock.method(globalThis, 'fetch', impl as unknown as typeof fetch);
  // 注入时钟与等待，保留真实的限流逻辑，不消耗墙钟时间。
  const time = opts.time ?? { now: 1_800_000_000_000, waits: [] };
  return new GeckoTerminalClient({
    requestsPerMinute: opts.requestsPerMinute ?? 60_000, retryBaseMs: opts.retryBaseMs ?? 1,
    clock: () => time.now, sleep: async (ms) => { time.waits.push(ms); time.now += ms; },
  });
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
  assert.equal(seen!.searchParams.get('currency'), 'usd');
  assert.equal(seen!.searchParams.get('include_empty_intervals'), 'true');

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

const TARGET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const QUOTE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const withIdentity = (rows: number[][], base = TARGET, quote = QUOTE) => Response.json({
  data: { attributes: { ohlcv_list: rows } },
  meta: { base: { address: base }, quote: { address: quote } },
});
const validationError = (error: unknown) => error instanceof GeckoTerminalError && error.code === 'GECKO_VALIDATION';

test('网络适配仅转换已确认的别名，规范 ID 和未知 ID 保持原样', () => {
  const cases = [
    ['ethereum', 'eth'], ['avalanche', 'avax'], ['xlayer', 'x-layer'],
    ['eth', 'eth'], ['avax', 'avax'], ['x-layer', 'x-layer'],
    ['hyperevm', 'hyperevm'], ['bsc', 'bsc'], ['solana', 'solana'],
    ['unknown-chain', 'unknown-chain'], ['constructor', 'constructor'], ['__proto__', '__proto__'],
  ];
  for (const [input, expected] of cases) assert.equal(resolveGeckoNetwork(input!), expected);
});

test('请求使用 Gecko 网络 ID、USD、完整空周期与目标 CA，并夹紧数量', async (t) => {
  let seen: URL | undefined;
  const gecko = client(t, async (url) => { seen = url; return withIdentity(sample); });
  await gecko.getCandles15m('ethereum', '0xpool', 5_000, TARGET.toUpperCase());
  assert.equal(seen!.pathname, '/api/v2/networks/eth/pools/0xpool/ohlcv/minute');
  assert.equal(seen!.searchParams.get('limit'), '1000');
  assert.equal(seen!.searchParams.get('currency'), 'usd');
  assert.equal(seen!.searchParams.get('include_empty_intervals'), 'true');
  assert.equal(seen!.searchParams.get('token'), TARGET);
});

test('目标位于 Gecko quote 一侧时仍请求目标 CA，不能默认取 base 价格', async (t) => {
  let seen: URL | undefined;
  const gecko = client(t, async (url) => { seen = url; return withIdentity(sample, QUOTE, TARGET); });
  const bars = await gecko.getCandles15m('bsc', '0xpool', 1000, TARGET);
  assert.equal(seen!.searchParams.get('token'), TARGET);
  assert.equal(bars[1]!.close, 2.5, 'USD 响应不能在本地再倒数反转');
});

test('目标地址缺失、不匹配、重复在两侧或非 EVM 大小写不符都拒绝', async (t) => {
  const cases: Array<{ response: () => Response; target: string }> = [
    { response: () => body(sample), target: TARGET },
    { response: () => withIdentity(sample, QUOTE, 'unrelated'), target: TARGET },
    { response: () => withIdentity(sample, TARGET, TARGET), target: TARGET },
    { response: () => withIdentity(sample, 'MintAbCd', 'MintOther'), target: 'mintabcd' },
    { response: () => Response.json({ data: { attributes: { ohlcv_list: sample } },
      meta: { base: { address: TARGET }, quote: { address: ' ' } } }), target: TARGET },
    { response: () => Response.json({ data: { attributes: { ohlcv_list: sample } },
      meta: { base: { address: TARGET } } }), target: TARGET },
  ];
  for (const { response, target } of cases) {
    const gecko = client(t, async () => response());
    await assert.rejects(gecko.getCandles15m('bsc', '0xpool', 1000, target), validationError);
  }
});

test('上游确认的无成交平价零量 K 线可入库，重复相同 bar 只保留一根', async (t) => {
  const flat = [1_789_137_900, 2, 2, 2, 2, 0];
  const gecko = client(t, async () => withIdentity([...sample, flat, sample[0]!]));
  const bars = await gecko.getCandles15m('bsc', '0xpool', 1000, TARGET);
  assert.equal(bars.length, 3);
  assert.deepEqual(bars[0], { openTime: flat[0]! * 1000, open: 2, high: 2, low: 2, close: 2, volume: 0 });
});

test('响应中的缺失周期保持缺失，不在本地把未知行情补成平价', async (t) => {
  const gecko = client(t, async () => body([
    [1_789_139_700, 2, 2, 2, 2, 0],
    [1_789_137_900, 2, 2, 2, 2, 0],
  ]));
  const bars = await gecko.getCandles15m('bsc', '0xpool');
  assert.equal(bars.length, 2);
  assert.equal(bars[1]!.openTime - bars[0]!.openTime, 1_800_000);
});

test('拒绝无效 OHLC、负成交量、不对齐时间与同一时间冲突', async (t) => {
  const invalidRows = [
    [1_789_138_801, 1, 2, 0.5, 2, 50],
    [1_789_138_800.1, 1, 2, 0.5, 2, 50],
    [-900, 1, 2, 0.5, 2, 50],
    [1_789_138_800, 1, 2, 0.5, 2, -1],
    [1_789_138_800, 1, 1, 0.5, 2, 50],
    [1_789_138_800, 1, 3, 2, 2, 50],
    [1_789_138_800, -1, 3, 0.5, 2, 50],
    [1_789_138_800, 1, 3, 0, 2, 50],
    [1_789_138_800, 1, Infinity, 0.5, 2, 50],
  ];
  for (const row of invalidRows) {
    const gecko = client(t, async () => body([row]));
    await assert.rejects(gecko.getCandles15m('bsc', '0xpool'), validationError);
  }
  const conflicting = client(t, async () => body([...sample, [1_789_138_800, 1, 2, 0.5, 1.5, 50]]));
  await assert.rejects(conflicting.getCandles15m('bsc', '0xpool'), validationError);
});

test('无效 JSON 是固定的校验错误，不泄露原始响应', async (t) => {
  const gecko = client(t, async () => new Response('PRIVATE_RESPONSE_TEXT'));
  await assert.rejects(gecko.getCandles15m('bsc', '0xpool'), (error: unknown) =>
    validationError(error) && !(error as Error).message.includes('PRIVATE_RESPONSE_TEXT'));
});

test('网络和 5xx 都重试，所有尝试至少相隔 6 秒，并释放失败响应', async (t) => {
  const time: FakeClock = { now: 1_800_000_000_000, waits: [] };
  const starts: number[] = [];
  let cancelled = false;
  const gecko = client(t, async () => {
    starts.push(time.now);
    if (starts.length === 1) {
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
    }
    if (starts.length === 2) throw new Error('PRIVATE_NETWORK_DETAILS');
    return body(sample);
  }, { time });
  assert.equal((await gecko.getCandles15m('bsc', '0xpool')).length, 2);
  assert.equal(starts.length, 3);
  assert.equal(cancelled, true);
  assert.ok(starts.every((start, index) => index === 0 || start - starts[index - 1]! >= 6_000));
});

test('持续网络或 5xx 故障最多重试三次，404 不重试', async (t) => {
  for (const kind of ['network', 'server', '404']) {
    let calls = 0;
    const gecko = client(t, async () => {
      calls++;
      if (kind === 'network') throw new Error('PRIVATE_NETWORK_DETAILS');
      return new Response('failed', { status: kind === 'server' ? 502 : 404 });
    });
    await assert.rejects(gecko.getCandles15m('bsc', '0xpool'), (error: unknown) =>
      error instanceof GeckoTerminalError && error.code === (kind === 'network' ? 'GECKO_NETWORK' : 'GECKO_HTTP')
      && !error.message.includes('PRIVATE_NETWORK_DETAILS'));
    assert.equal(calls, kind === '404' ? 1 : 4);
  }
});

test('429 遵守 Retry-After 的秒数和 HTTP 日期，并持久化独立冷却', async (t) => {
  for (const headerKind of ['seconds', 'date']) {
    const time: FakeClock = { now: 1_800_000_000_000, waits: [] };
    const firstStart = time.now;
    let until = 0;
    const starts: number[] = [];
    const gecko = client(t, async () => {
      starts.push(time.now);
      return starts.length === 1 ? new Response('limited', { status: 429,
        headers: { 'Retry-After': headerKind === 'seconds' ? '15' : new Date(firstStart + 15_000).toUTCString() } })
        : body(sample);
    }, { time });
    gecko.setRateLimitStore({ getUntil: () => until, setUntil: (value) => { until = value; } });
    assert.equal((await gecko.getCandles15m('bsc', '0xpool')).length, 2);
    assert.equal(starts.length, 2);
    assert.ok(starts[1]! - starts[0]! >= 15_000);
    assert.equal(until, firstStart + 15_000);
  }
});

test('长 Retry-After 立即返回冷却，重建客户端仍阻止请求，冷却后恢复', async (t) => {
  const time: FakeClock = { now: 1_800_000_000_000, waits: [] };
  let until = 0;
  let calls = 0;
  const store = { getUntil: () => until, setUntil: (value: number) => { until = value; } };
  const gecko = client(t, async () => {
    calls++;
    return new Response('limited', { status: 429, headers: { 'Retry-After': '120' } });
  }, { time });
  gecko.setRateLimitStore(store);
  await assert.rejects(gecko.getCandles15m('bsc', '0xpool'), (error: unknown) =>
    error instanceof GeckoTerminalError && error.code === 'GECKO_RATE_LIMIT' && error.retryAt === until);
  assert.equal(calls, 1);
  assert.deepEqual(time.waits, []);
  assert.equal(until, time.now + 120_000);

  const restarted = client(t, async () => { calls++; return body(sample); }, { time });
  restarted.setRateLimitStore(store);
  await assert.rejects(restarted.getCandles15m('bsc', '0xpool'), (error: unknown) =>
    error instanceof GeckoTerminalError && error.code === 'GECKO_RATE_LIMIT');
  assert.equal(calls, 1, '冷却未到不得调用 fetch');
  time.now = until;
  assert.equal((await restarted.getCandles15m('bsc', '0xpool')).length, 2);
  assert.equal(calls, 2);
});

test('数量、目标地址和速率配置无效时不发送请求', async (t) => {
  let calls = 0;
  const gecko = client(t, async () => { calls++; return body(sample); });
  for (const limit of [0, -1, 1.5, Infinity, NaN]) {
    await assert.rejects(gecko.getCandles15m('bsc', '0xpool', limit),
      (error: unknown) => error instanceof GeckoTerminalError && error.code === 'GECKO_INPUT');
  }
  await assert.rejects(gecko.getCandles15m('bsc', '0xpool', 1000, ' '),
    (error: unknown) => error instanceof GeckoTerminalError && error.code === 'GECKO_INPUT');
  for (const rpm of [0, -1, Infinity, NaN]) {
    assert.throws(() => new GeckoTerminalClient({ requestsPerMinute: rpm }),
      (error: unknown) => error instanceof GeckoTerminalError && error.code === 'GECKO_INPUT');
  }
  assert.equal(calls, 0);
});

test('271个全池任务及重试共享8次每分钟预算，不因扩池或失败瞬间突发', async (t) => {
  const time: FakeClock = { now: 1_800_000_000_000, waits: [] };
  const starts: number[] = [];
  const gecko = client(t, async () => {
    starts.push(time.now);
    if (starts.length === 2) return new Response('temporary failure', {status:503});
    return body(sample);
  }, {time, requestsPerMinute:8});
  for (let i=0;i<271;i++) await gecko.getCandles15m('solana','pool-'+i);
  assert.equal(starts.length,272);
  for (let i=1;i<starts.length;i++) assert.ok(starts[i]!-starts[i-1]! >= 7500);
  for (const start of starts) assert.ok(starts.filter(t=>t>=start&&t<start+60000).length<=8);
  assert.ok(starts.at(-1)!-starts[0]! >= 33*60000, '不能宣称271个串行REST请求在30分钟内全量更新');
});
