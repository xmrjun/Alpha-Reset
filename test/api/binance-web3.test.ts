import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { BinanceWeb3Client, BinanceWeb3Error, resolveBinanceChain } from '../../src/api/binance-web3.js';

const M = 15 * 60_000;
const T = Math.floor(Date.parse('2026-09-16T08:00:00Z') / M) * M;
const SOL = '14B28DLfB4aVcqMasCLcC9jJPhmWyrxBkBjLRtcRPYrN';
const EVM = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';

/** 上游行：[open, high, low, close, volume, openTime, trades] */
const row = (t: number, close = 10) => [10, 12, 9, close, 100, t, 5];
let keySeq = 0;
const body = (rows: unknown[]) => ({ code: 0, msg: '', success: true, data: rows });

function client(t: TestContext, handler: (url: URL) => { status?: number; json?: unknown; headers?: Record<string, string> }) {
  const calls: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const r = handler(url);
    return new Response(r.json === undefined ? '' : JSON.stringify(r.json),
      { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  });
  // 虚拟时钟：sleep 推进它。固定时钟会让节流循环 while (target > now) 永远自旋。
  let now = T + M;
  // 限速预算按凭据哈希在模块级共享（生产上同一账号共用一条队列，含冷却），
  // 所以每个用例必须用不同 key，否则 429 冷却会污染后续用例。
  const apiKey = 'sk-test-' + (keySeq++);
  return { calls, c: new BinanceWeb3Client({ apiKey, requestsPerMinute: 60_000,
    clock: () => now, sleep: async (ms: number) => { now += Math.max(Math.ceil(ms), 1); } }) };
}

test('链映射覆盖实测的 15 条；池中 arc / xlayer / hyperevm 明确返回 null', () => {
  assert.equal(resolveBinanceChain('robinhood'), '4663');
  assert.equal(resolveBinanceChain('bsc'), '56');
  assert.equal(resolveBinanceChain('solana'), 'CT_501');
  assert.equal(resolveBinanceChain('Solana'), 'CT_501', '大小写不敏感');
  assert.equal(resolveBinanceChain(' ethereum '), '1', '去空白');
  for (const missing of ['arc', 'xlayer', 'hyperevm', 'tron', '']) assert.equal(resolveBinanceChain(missing), null, missing);
});

test('非法链、地址或窗口直接拒绝，不发出任何请求', async (t) => {
  const { calls, c } = client(t, () => ({ json: body([]) }));
  const range = { from: T - 10 * M, to: T };
  for (const [chain, ca] of [['arc', EVM], ['bsc', 'not-an-address'], ['solana', EVM], ['bsc', SOL]] as const) {
    await assert.rejects(() => c.getCandles15m(chain, ca, range), (e: BinanceWeb3Error) => e.code === 'BINANCE_INPUT');
  }
  await assert.rejects(() => c.getCandles15m('bsc', EVM, { from: T, to: T }),
    (e: BinanceWeb3Error) => e.code === 'BINANCE_INPUT');
  assert.equal(calls.length, 0, '参数非法时不得发请求');
});

test('请求带上正确的链 ID、地址、bar 与上限，凭据只走请求头', async (t) => {
  const { calls, c } = client(t, () => ({ json: body([row(T - M)]) }));
  await c.getCandles15m('robinhood', EVM, { from: T - 10 * M, to: T });
  const url = calls[0]!;
  assert.equal(url.searchParams.get('binanceChainId'), '4663');
  assert.equal(url.searchParams.get('tokenContractAddress'), EVM);
  assert.equal(url.searchParams.get('bar'), '15m');
  assert.equal(url.searchParams.get('limit'), '300');
  assert.equal(url.searchParams.get('after'), null, '首页不带游标');
  assert.equal(/sk-test/.test(url.href), false, '凭据不得出现在 URL');
});

test('窗口超过单页上限时按 after 向更早翻页，游标取本页最早一根', async (t) => {
  const pages = new Map<string, unknown[]>();
  const newest = Array.from({ length: 300 }, (_, i) => row(T - (300 - i) * M));
  const older = Array.from({ length: 300 }, (_, i) => row(T - (600 - i) * M));
  pages.set('none', newest);
  pages.set(String(T - 300 * M), older);
  const { calls, c } = client(t, (url) => ({ json: body(pages.get(url.searchParams.get('after') ?? 'none') ?? []) }));
  const res = await c.getCandles15m('bsc', EVM, { from: T - 600 * M, to: T });
  assert.equal(calls.length, 2, '第二页最早一根已达窗口起点，无需再探一次');
  assert.equal(calls[1]!.searchParams.get('after'), String(T - 300 * M));
  assert.equal(res.candles.length, 600);
  const times = res.candles.map((x) => x.openTime);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), '结果按时间升序');
  assert.equal(new Set(times).size, times.length, '跨页不得重复');
});

test('游标不推进时立即停止，不陷入死循环', async (t) => {
  const stuck = Array.from({ length: 300 }, (_, i) => row(T - (300 - i) * M));
  const { calls, c } = client(t, () => ({ json: body(stuck) }));
  const res = await c.getCandles15m('bsc', EVM, { from: T - 5000 * M, to: T });
  assert.ok(calls.length <= 3, `应尽快停止，实际 ${calls.length} 次`);
  assert.equal(res.exhausted, true);
});

test('只返回窗口内且已收盘的 bar；未收盘与越界的一律丢弃', async (t) => {
  const { c } = client(t, () => ({ json: body([
    row(T - 3 * M), row(T - 2 * M), row(T - M), row(T), row(T + M), row(T - 50 * M),
  ]) }));
  const res = await c.getCandles15m('bsc', EVM, { from: T - 3 * M, to: T });
  // clock 为 T+M，故 openTime=T 的那根（收于 T+M）恰好已收盘，但超出 to 被窗口排除
  assert.deepEqual(res.candles.map((x) => x.openTime), [T - 3 * M, T - 2 * M, T - M]);
});

test('未对齐 15m 网格、OHLC 关系不成立或非正价格的响应整体拒绝', async (t) => {
  for (const bad of [
    [[10, 12, 9, 11, 100, T - M + 1, 5]],          // 未对齐
    [[10, 8, 9, 11, 100, T - M, 5]],                // high < max(open, close)
    [[10, 12, 11.5, 11, 100, T - M, 5]],            // low > min(open, close)
    [[0, 12, 9, 11, 100, T - M, 5]],                // 非正开盘价
    [[10, 12, 9, 11, -1, T - M, 5]],                // 负成交量
  ]) {
    const { c } = client(t, () => ({ json: body(bad) }));
    await assert.rejects(() => c.getCandles15m('bsc', EVM, { from: T - 10 * M, to: T }),
      (e: BinanceWeb3Error) => e.code === 'BINANCE_VALIDATION', JSON.stringify(bad));
  }
});

test('同一时刻出现冲突 K 线时拒绝整页，不静默取其一', async (t) => {
  const { c } = client(t, () => ({ json: body([row(T - M, 10), row(T - M, 99)]) }));
  await assert.rejects(() => c.getCandles15m('bsc', EVM, { from: T - 10 * M, to: T }),
    (e: BinanceWeb3Error) => e.code === 'BINANCE_VALIDATION');
});

test('网关对业务错误也返回 200，必须按 success 判定而非 HTTP 状态', async (t) => {
  const { c } = client(t, () => ({ status: 200, json: { code: 40001, msg: 'Parameter bar error', success: false, data: null } }));
  await assert.rejects(() => c.getCandles15m('bsc', EVM, { from: T - 10 * M, to: T }),
    (e: BinanceWeb3Error) => e.code === 'BINANCE_STATUS');
});

test('鉴权失败单独成码，便于上层暂停该来源而不影响其他源', async (t) => {
  for (const status of [401, 403]) {
    const { c } = client(t, () => ({ status, json: { message: 'Missing API key' } }));
    await assert.rejects(() => c.getCandles15m('bsc', EVM, { from: T - 10 * M, to: T }),
      (e: BinanceWeb3Error) => e.code === 'BINANCE_AUTH' && e.httpStatus === status);
  }
});

test('429 按 x-ratelimit-reset 记录冷却，并写入独立的限流存储', async (t) => {
  let stored = 0;
  const reset = Math.floor((T + 30_000) / 1000);
  const { c } = client(t, () => ({ status: 429, json: {}, headers: { 'x-ratelimit-reset': String(reset) } }));
  c.setRateLimitStore({ getUntil: () => stored, setUntil: (v: number) => { stored = v; } });
  await assert.rejects(() => c.getCandles15m('bsc', EVM, { from: T - 10 * M, to: T }),
    (e: BinanceWeb3Error) => e.code === 'BINANCE_RATE_LIMIT' && e.httpStatus === 429);
  assert.ok(stored >= reset * 1000, '冷却时间已持久化');
});

test('冷却未过期时直接拒绝，不再发出请求', async (t) => {
  const { calls, c } = client(t, () => ({ json: body([]) }));
  c.setRateLimitStore({ getUntil: () => T + 60 * M, setUntil: () => {} });
  await assert.rejects(() => c.getCandles15m('bsc', EVM, { from: T - 10 * M, to: T }),
    (e: BinanceWeb3Error) => e.code === 'BINANCE_RATE_LIMIT');
  assert.equal(calls.length, 0);
});

test('5xx 与网络错误重试后仍失败则抛出；4xx 不重试', async (t) => {
  let n = 0;
  const { c } = client(t, () => { n++; return { status: 503, json: {} }; });
  await assert.rejects(() => c.getCandles15m('bsc', EVM, { from: T - 10 * M, to: T }),
    (e: BinanceWeb3Error) => e.code === 'BINANCE_HTTP');
  assert.equal(n, 3, '2 次重试 + 首次');
  n = 0;
  const { c: c2 } = client(t, () => { n++; return { status: 400, json: { success: false } }; });
  await assert.rejects(() => c2.getCandles15m('bsc', EVM, { from: T - 10 * M, to: T }));
  assert.equal(n, 1, '4xx 不重试');
});

test('结果标注 token 范围身份，pool 为 null，不得与固定池序列混用', async (t) => {
  const { c } = client(t, () => ({ json: body([row(T - M)]) }));
  const res = await c.getCandles15m('Robinhood', EVM, { from: T - 10 * M, to: T });
  assert.deepEqual(res.source, { provider: 'binance', scope: 'token', chain: 'robinhood', ca: EVM, currency: 'usd', pool: null });
});
