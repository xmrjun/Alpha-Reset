import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { test, type TestContext } from 'node:test';
import { GmgnClient, GmgnError, resolveGmgnChain, type GmgnClientOptions, type GmgnErrorCode } from '../../src/api/gmgn.js';

const CA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SOL = 'So11111111111111111111111111111111111111112';
const T = 1_800_000_000_000;
const I = 900_000;
const RANGE = { from: T - 4 * I, to: T };
const row = (time = T - I, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  time, open: '1', high: '2', low: '0.5', close: '1.5', volume: '150', amount: '100', ...overrides,
});
const success = (rows: unknown[] = [row()]) => Response.json({ code: 0, data: { list: rows } });
type FetchMock = (url: URL, init: RequestInit) => Promise<Response>;
interface FakeTime { now: number; waits: number[] }
let nextKey = 0;

function setup(t: TestContext, fetchMock: FetchMock = async () => success(),
  opts: Partial<GmgnClientOptions> = {}) {
  // 仅使用虚构凭据，测试期间所有 fetch 都被替换；绝不读取环境 Key。
  const apiKey = opts.apiKey ?? 'gmgn_fixture_key_' + ++nextKey;
  const time: FakeTime = { now: T, waits: [] };
  const options: GmgnClientOptions = { ...opts, apiKey,
    clock: opts.clock ?? (() => time.now),
    sleep: opts.sleep ?? (async (ms) => { time.waits.push(ms); time.now += ms; }),
  };
  t.mock.method(globalThis, 'fetch', fetchMock as unknown as typeof fetch);
  return { client: new GmgnClient(options), options, time, apiKey };
}
const hasCode = (code: GmgnErrorCode) => (error: unknown) => error instanceof GmgnError && error.code === code;

function sanitized(code: GmgnErrorCode, ...secrets: string[]) {
  return (error: unknown) => {
    assert.ok(error instanceof GmgnError);
    assert.equal(error.code, code);
    const printable = String(error) + JSON.stringify(error) + inspect(error, { depth: 10 });
    for (const secret of secrets) assert.ok(!printable.includes(secret), '错误不得携带请求或响应敏感文本');
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('GMGN 使用固定官方只读端点、毫秒窗口和秒认证；无需私钥或签名', async (t) => {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const { client, apiKey } = setup(t, async (url, init) => {
    requests.push({ url, init });
    return success([row(T - I, { source: 'UNTRUSTED_SOURCE_TEXT', amount: '999999999' })]);
  });
  const result = await client.getCandles15m(' Ethereum ', CA.toUpperCase(), RANGE);
  await client.getCandles15m('eth', CA, RANGE);
  assert.equal(requests.length, 2, '每个调用只有一窗，不能暗中追加历史请求');
  const first = requests[0]!;
  assert.equal(first.url.origin, 'https://openapi.gmgn.ai');
  assert.equal(first.url.pathname, '/v1/market/token_kline');
  assert.equal(first.url.searchParams.get('chain'), 'eth');
  assert.equal(first.url.searchParams.get('address'), CA);
  assert.equal(first.url.searchParams.get('resolution'), '15m');
  assert.equal(first.url.searchParams.get('from'), String(RANGE.from));
  assert.equal(first.url.searchParams.get('to'), String(RANGE.to));
  assert.equal(first.url.searchParams.get('timestamp'), String(T / 1000));
  assert.deepEqual([...first.url.searchParams.keys()].sort(), ['address', 'chain', 'client_id', 'from', 'resolution', 'timestamp', 'to']);
  assert.match(first.url.searchParams.get('client_id')!, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.notEqual(first.url.searchParams.get('client_id'), requests[1]!.url.searchParams.get('client_id'));
  const headers = new Headers(first.init.headers);
  assert.equal(headers.get('X-APIKEY'), apiKey);
  assert.equal(headers.get('X-Signature'), null);
  assert.equal(first.init.method, 'GET');
  assert.equal(first.init.redirect, 'error');
  assert.equal(first.init.body, undefined);
  assert.ok(first.init.signal instanceof AbortSignal);
  assert.ok(!first.url.href.includes(apiKey));
  assert.deepEqual(result.source, { provider: 'gmgn', scope: 'token', chain: 'eth', ca: CA, currency: 'usd', pool: null });
  assert.deepEqual(result.candles, [{ openTime: T - I, open: 1, high: 2, low: 0.5, close: 1.5, volume: 150 }]);
  assert.ok(!JSON.stringify(result).includes('UNTRUSTED_SOURCE_TEXT'));
});

test('链别名仅映射已知标识，九链可请求，未知链与非法 CA 本地拒绝', async (t) => {
  const seen: string[] = [];
  const { client } = setup(t, async (url) => { seen.push(url.searchParams.get('chain')!); return success([]); });
  assert.equal(resolveGmgnChain(' SOLANA '), 'sol');
  assert.equal(resolveGmgnChain('ethereum'), 'eth');
  for (const chain of ['sol', 'bsc', 'base', 'eth', 'arbitrum', 'hyperevm', 'robinhood', 'arc', 'stable']) {
    await client.getCandles15m(chain, chain === 'sol' ? SOL : CA, RANGE);
  }
  assert.equal(seen.length, 9);
  for (const chain of ['tron', 'xlayer', 'x-layer', 'avalanche', 'unknown', '']) {
    assert.equal(resolveGmgnChain(chain), null);
    await assert.rejects(client.getCandles15m(chain, CA, RANGE), hasCode('GMGN_INPUT'));
  }
  for (const ca of ['', '0xabc', '0x' + 'z'.repeat(40), CA + '?secret=bad', SOL]) {
    await assert.rejects(client.getCandles15m('bsc', ca, RANGE), hasCode('GMGN_INPUT'));
  }
  await assert.rejects(client.getCandles15m('solana', CA, RANGE), hasCode('GMGN_INPUT'));
  assert.equal(seen.length, 9);
});

test('配置和窗口错误不发网络；错误不回显输入', async (t) => {
  let calls = 0;
  const { client } = setup(t, async () => { calls++; return success(); });
  for (const apiKey of ['', '  ', 'fake\nAuthorization: SENSITIVE_HEADER']) {
    assert.throws(() => new GmgnClient({ apiKey }), sanitized('GMGN_INPUT', 'SENSITIVE_HEADER'));
  }
  for (const requestsPerMinute of [0, -1, Infinity, NaN, Number.MIN_VALUE]) {
    assert.throws(() => new GmgnClient({ apiKey: 'fake_config_key', requestsPerMinute }), hasCode('GMGN_INPUT'));
  }
  for (const retryBaseMs of [-1, Infinity, NaN, 1.5]) {
    assert.throws(() => new GmgnClient({ apiKey: 'fake_config_key', retryBaseMs }), hasCode('GMGN_INPUT'));
  }
  for (const range of [{ from: T, to: T }, { from: T, to: T - 1 }, { from: -1, to: T },
    { from: T - I + 0.5, to: T }, { from: T - I, to: NaN }, { from: T - I, to: Infinity },
    { from: 0, to: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(client.getCandles15m('bsc', CA, range), hasCode('GMGN_INPUT'));
  }
  assert.equal(calls, 0);
});

test('已收盘过滤固定在调用开始时刻，窗口为 [from,to)，晚到响应不引入新收盘', async (t) => {
  const { client, time } = setup(t, async () => {
    time.now += 2 * I;
    return success([row(T + I), row(T), row(T - I), row(T - 2 * I), row(T - 3 * I), row(T + 3 * I)]);
  });
  time.now = T + 500;
  const result = await client.getCandles15m('bsc', CA, { from: T - 2 * I, to: T + 3 * I });
  assert.deepEqual(result.candles.map((bar) => bar.openTime), [T - 2 * I, T - I]);
});

test('to 也限制收盘时间，保留真零量且不生成缺失区间', async (t) => {
  const { client } = setup(t, async () => success([
    row(T - I), row(T - 2 * I, { open: '2', high: '2', low: '2', close: '2', volume: '0' }),
    row(T - 4 * I), row(T - 4 * I),
  ]));
  const result = await client.getCandles15m('bsc', CA, { from: T - 4 * I, to: T - I });
  assert.deepEqual(result.candles.map((bar) => bar.openTime), [T - 4 * I, T - 2 * I]);
  assert.equal(result.candles[1]!.volume, 0);
  assert.equal(result.candles[1]!.openTime - result.candles[0]!.openTime, 2 * I);
});

test('空成功列表与失败响应可区分，非数字 0 的业务 code 一律拒绝', async (t) => {
  const { client } = setup(t, async () => success([]));
  assert.deepEqual((await client.getCandles15m('bsc', CA, RANGE)).candles, []);
  for (const code of ['0', 1, null, false]) {
    const { client: bad, apiKey } = setup(t, async () => Response.json({ code, message: 'BODY_SECRET', data: { list: [] } }));
    await assert.rejects(bad.getCandles15m('bsc', CA, RANGE), sanitized('GMGN_STATUS', 'BODY_SECRET', apiKey));
  }
});

test('严格校验 OHLC/成交额/15m 时间，任何坏行拒绝整个响应而非静默丢弃', async (t) => {
  const overrides: Record<string, unknown>[] = [
    { time: T - I + 1 }, { time: T - I + 0.5 }, { time: -I }, { time: (T - I) / 1000 },
    { time: Number.MAX_SAFE_INTEGER + 1 }, { time: String(T - I) },
    { open: 1 }, { open: '0' }, { low: '-1' }, { low: '0' }, { close: 'NaN' },
    { high: '1e309' }, { high: '1.1' }, { low: '1.2' }, { open: null },
    { volume: '-1' }, { volume: '' }, { volume: ' ' }, { volume: null }, { volume: undefined },
    { volume: '0x10' }, { volume: 'Infinity' }, { volume: '1e-1000' }, { volume: 0 },
  ];
  for (const fields of overrides) {
    const { client } = setup(t, async () => success([row(), row(T - 2 * I, fields)]));
    await assert.rejects(client.getCandles15m('bsc', CA, RANGE), hasCode('GMGN_VALIDATION'));
  }
});

test('相同时间同值允许去重；OHLC 或成交额冲突均拒绝，包括窗口外冲突', async (t) => {
  const { client } = setup(t, async () => success([row(), row(T - 2 * I), row(T - I, { volume: '1.50e2' })]));
  assert.deepEqual((await client.getCandles15m('bsc', CA, RANGE)).candles.map((bar) => bar.openTime), [T - 2 * I, T - I]);
  for (const fields of [{ close: '1.6' }, { volume: '151' }, { high: '3' }]) {
    const { client: bad } = setup(t, async () => success([row(T + I), row(T + I, fields)]));
    await assert.rejects(bad.getCandles15m('bsc', CA, RANGE), hasCode('GMGN_VALIDATION'));
  }
});

test('非 JSON、缺少 list、错误类型和上游错误文本不泄露', async (t) => {
  const bodies = ['RESPONSE_SECRET', '{}', '{"code":0,"data":{}}', '{"code":0,"data":{"list":null}}'];
  for (const text of bodies) {
    const { client, apiKey } = setup(t, async () => new Response(text));
    await assert.rejects(client.getCandles15m('bsc', CA, RANGE), sanitized('GMGN_VALIDATION', 'RESPONSE_SECRET', apiKey));
  }
});

test('同一 Key 的跨客户端并发和重试共享默认 30/min 单队列，认证每次更新', async (t) => {
  const starts: number[] = [];
  const ids: string[] = [];
  const timestamps: number[] = [];
  const { client, options, time } = setup(t, async (url) => {
    starts.push(time.now);
    ids.push(url.searchParams.get('client_id')!);
    timestamps.push(Number(url.searchParams.get('timestamp')));
    return starts.length === 1 ? new Response('private failure', { status: 503 }) : success();
  }, { retryBaseMs: 1 });
  const second = new GmgnClient({ ...options, requestsPerMinute: 600 });
  await Promise.all([client.getCandles15m('bsc', CA, RANGE), second.getCandles15m('eth', CA, RANGE),
    client.getCandles15m('base', CA, RANGE)]);
  assert.equal(starts.length, 4);
  for (let index = 1; index < starts.length; index++) assert.ok(starts[index]! - starts[index - 1]! >= 2000);
  assert.equal(new Set(ids).size, 4);
  assert.deepEqual(timestamps, starts.map((start) => Math.floor(start / 1000)));
});

test('较低配置覆盖所有初次和重试请求，网络及 5xx 最多重试两次', async (t) => {
  for (const mode of ['network', 'server']) {
    const starts: number[] = [];
    let cancelled = 0;
    const { client, time, apiKey } = setup(t, async () => {
      starts.push(time.now);
      if (mode === 'network') throw new Error('NETWORK_SECRET ' + apiKey);
      return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 502 });
    }, { requestsPerMinute: 8, retryBaseMs: 1 });
    await assert.rejects(client.getCandles15m('bsc', CA, RANGE),
      sanitized(mode === 'network' ? 'GMGN_NETWORK' : 'GMGN_HTTP', 'NETWORK_SECRET', apiKey));
    assert.equal(starts.length, 3);
    assert.deepEqual(starts, [T, T + 7500, T + 15000]);
    if (mode === 'server') assert.equal(cancelled, 3);
  }
});

test('网络错误、5xx 后第三次可成功；配置退避与统一节流取较晚时间', async (t) => {
  const starts: number[] = [];
  const { client, time } = setup(t, async () => {
    starts.push(time.now);
    if (starts.length === 1) throw new Error('NETWORK_SECRET');
    if (starts.length === 2) return new Response('SERVER_SECRET', { status: 503 });
    return success();
  }, { retryBaseMs: 5000 });
  assert.equal((await client.getCandles15m('bsc', CA, RANGE)).candles.length, 1);
  assert.deepEqual(starts, [T, T + 5000, T + 15000]);
});

test('401、403、其他 4xx 和 3xx 不重试，响应体被释放且不泄露', async (t) => {
  for (const status of [301, 400, 401, 403, 404]) {
    let calls = 0;
    let cancelled = false;
    const { client, apiKey } = setup(t, async () => {
      calls++;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }),
        { status, headers: { Location: 'https://invalid.example/RESPONSE_SECRET' } });
    });
    await assert.rejects(client.getCandles15m('bsc', CA, RANGE), sanitized('GMGN_HTTP', 'RESPONSE_SECRET', apiKey));
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  }
});

test('429 取 reset header、body 和 Retry-After 中最晚者再加一秒，阻止已排队的其他客户端', async (t) => {
  for (const latest of ['header', 'body', 'retry-seconds', 'retry-date']) {
    let calls = 0;
    let until = 0;
    const { client, options, time } = setup(t, async () => {
      calls++;
      return Response.json({ code: 429, error: 'RATE_LIMIT_BANNED', message: 'BODY_SECRET',
        reset_at: (T + (latest === 'body' ? 40000 : 10000)) / 1000 }, {
        status: 429, headers: {
          'X-RateLimit-Reset': String((T + (latest === 'header' ? 40000 : 20000)) / 1000),
          'Retry-After': latest === 'retry-date' ? new Date(T + 40000).toUTCString()
            : latest === 'retry-seconds' ? '40' : '30',
        },
      });
    });
    client.setRateLimitStore({ getUntil: () => until, setUntil: (value) => { until = value; } });
    const second = new GmgnClient(options);
    const results = await Promise.allSettled([client.getCandles15m('bsc', CA, RANGE), second.getCandles15m('eth', CA, RANGE)]);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') {
        assert.ok(result.reason instanceof GmgnError);
        assert.equal(result.reason.code, 'GMGN_RATE_LIMIT');
        assert.equal(result.reason.retryAt, T + 41000);
      }
    }
    assert.equal(until, T + 41000);
    assert.equal(calls, 1);
    assert.deepEqual(time.waits, [], '429 立即交回调度方，不能内联等待或发探测请求');
  }
});

test('HTTP 200 的限流业务错误也持久冷却，字符串 0 不等于成功', async (t) => {
  let until = 0;
  const { client } = setup(t, async () => Response.json({ code: 429, error: 'RATE_LIMIT_EXCEEDED', reset_at: (T + 10000) / 1000 }),
    { rateLimitStore: { getUntil: () => until, setUntil: (value) => { until = value; } } });
  await assert.rejects(client.getCandles15m('bsc', CA, RANGE), hasCode('GMGN_RATE_LIMIT'));
  assert.equal(until, T + 11000);
});

test('429 缺失/非法恢复时间保守冷却，不泄露 body 或错误字段', async (t) => {
  for (const text of ['BODY_SECRET', JSON.stringify({ code: 429, reset_at: 'BODY_SECRET', error: 'BODY_SECRET' })]) {
    const { client, apiKey } = setup(t, async () => new Response(text, { status: 429,
      headers: { 'X-RateLimit-Reset': 'bad', 'Retry-After': 'bad' } }));
    await assert.rejects(client.getCandles15m('bsc', CA, RANGE), (error: unknown) => {
      sanitized('GMGN_RATE_LIMIT', 'BODY_SECRET', apiKey)(error);
      assert.equal((error as GmgnError).retryAt, T + 61000);
      return true;
    });
  }
});

test('GMGN 独立持久冷却跨客户端和重新加载模块恢复，冷却期间不发请求', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gmgn-cooldown-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'gmgn.json');
  writeFileSync(file, '0');
  const store = () => ({ getUntil: () => Number(readFileSync(file, 'utf8')),
    setUntil: (until: number) => writeFileSync(file, String(Math.max(until, Number(readFileSync(file, 'utf8'))))) });
  let calls = 0;
  const { client, options, time } = setup(t, async () => {
    calls++;
    return calls === 1 ? new Response('limited', { status: 429, headers: { 'Retry-After': '120' } }) : success();
  }, { rateLimitStore: store() });
  await assert.rejects(client.getCandles15m('bsc', CA, RANGE), hasCode('GMGN_RATE_LIMIT'));
  const until = Number(readFileSync(file, 'utf8'));
  assert.equal(until, T + 121000);
  const another = new GmgnClient({ ...options, rateLimitStore: store() });
  await assert.rejects(another.getCandles15m('bsc', CA, RANGE), hasCode('GMGN_RATE_LIMIT'));
  // 模拟新进程：重新加载模块，清空该模块的内存预算，只保留磁盘冷却。
  const fresh = await import(new URL('../../src/api/gmgn.js?fresh=restart-test', import.meta.url).href) as typeof import('../../src/api/gmgn.js');
  const restarted = new fresh.GmgnClient({ ...options, rateLimitStore: store() });
  await assert.rejects(restarted.getCandles15m('bsc', CA, RANGE), (error: unknown) =>
    error instanceof fresh.GmgnError && error.code === 'GMGN_RATE_LIMIT' && error.retryAt === until);
  assert.equal(calls, 1);
  time.now = until;
  assert.equal((await restarted.getCandles15m('bsc', CA, RANGE)).candles.length, 1);
  assert.equal(calls, 2);
});

test('排队等待期间出现持久冷却也阻止发出请求，冷却写入失败保留内存暂停', async (t) => {
  let until = 0;
  let now = T;
  let calls = 0;
  const { client } = setup(t, async () => { calls++; return success(); }, {
    clock: () => now,
    sleep: async (ms) => { now += ms; until = now + 60000; },
    rateLimitStore: { getUntil: () => until, setUntil: (value) => { until = value; } },
  });
  await client.getCandles15m('bsc', CA, RANGE);
  await assert.rejects(client.getCandles15m('eth', CA, RANGE), hasCode('GMGN_RATE_LIMIT'));
  assert.equal(calls, 1);

  const bad = setup(t, async () => new Response('limited', { status: 429 }), {
    rateLimitStore: { getUntil: () => 0, setUntil: () => { throw new Error('STORE_SECRET'); } },
  });
  await assert.rejects(bad.client.getCandles15m('bsc', CA, RANGE), sanitized('GMGN_STATE', 'STORE_SECRET'));
  const { rateLimitStore: ignoredStore, ...withoutStore } = bad.options;
  void ignoredStore;
  await assert.rejects(new GmgnClient(withoutStore).getCandles15m('eth', CA, RANGE), hasCode('GMGN_RATE_LIMIT'));
});

test('持久状态和时钟失败时封闭失败，注入异常不泄露', async (t) => {
  let calls = 0;
  for (const until of [-1, NaN, Infinity]) {
    const { client } = setup(t, async () => { calls++; return success(); }, {
      rateLimitStore: { getUntil: () => until, setUntil: () => {} },
    });
    await assert.rejects(client.getCandles15m('bsc', CA, RANGE), hasCode('GMGN_STATE'));
  }
  const { client } = setup(t, async () => { calls++; return success(); }, {
    clock: () => { throw new Error('CLOCK_SECRET'); },
  });
  await assert.rejects(client.getCandles15m('bsc', CA, RANGE), sanitized('GMGN_STATE', 'CLOCK_SECRET'));
  assert.equal(calls, 0);
});


test('大范围只返回上游提供的 100 根，保持单窗且不宣称历史完整', async (t) => {
  let calls = 0;
  const { client } = setup(t, async () => {
    calls++;
    return success(Array.from({ length: 100 }, (_, index) => row(T - (index + 1) * I)));
  });
  const result = await client.getCandles15m('robinhood', CA, { from: T - 10 * 24 * 60 * 60_000, to: T });
  assert.equal(calls, 1);
  assert.equal(result.candles.length, 100);
  assert.equal(result.candles[0]!.openTime, T - 100 * I);
  assert.equal(result.candles.at(-1)!.openTime, T - I);
  assert.ok(!Object.hasOwn(result, 'historyComplete'));
});
