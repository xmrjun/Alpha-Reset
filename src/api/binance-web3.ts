import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalCa } from '../addresses.js';
import type { Candle } from '../types.js';
import type { RateLimitStore } from './erwa.js';

const HOST = 'https://binance-web3-api.p.xapi.to';
const PATH = '/api/v1/dex/market/candles';
const INTERVAL_MS = 15 * 60_000;
/** 实测单次上限 300；请求更多返回 invalid limit range。 */
const MAX_LIMIT = 300;
/** 实测 x-ratelimit-limit: 10/秒；默认留一半余量。 */
const DEFAULT_RPM = 300;
const MAX_RETRIES = 2;
const MAX_PAGES = 6;
const UNKNOWN_COOLDOWN_MS = 60_000;
const RESET_BUFFER_MS = 1_000;

/**
 * 内部链名 → binanceChainId。取值来自 /api/v1/dex/market/supported/chain 实测，
 * 共 15 条。池中的 arc / xlayer / hyperevm 不在其中，调用方须按 null 跳过。
 */
const CHAIN_IDS: Readonly<Record<string, string>> = {
  ethereum: '1', eth: '1',
  bsc: '56', bnb: '56',
  solana: 'CT_501', sol: 'CT_501',
  base: '8453',
  sonic: '146',
  plasma: '9745',
  avalanche: '43114', avax: '43114',
  arbitrum: '42161',
  monad: '143',
  polygon: '137',
  linea: '59144',
  optimism: '10',
  zksync: '324',
  opbnb: '204',
  robinhood: '4663',
};
export function resolveBinanceChain(network: string): string | null {
  if (typeof network !== 'string') return null;
  return CHAIN_IDS[network.trim().toLowerCase()] ?? null;
}

/** 响应是数组的数组：[open, high, low, close, volume, openTime(ms), trades]，已实测 20/20 满足 OHLC 关系。 */
const num = z.number().finite();
const positive = num.pipe(z.number().positive());
const rowSchema = z.tuple([positive, positive, positive, positive,
  num.pipe(z.number().nonnegative()),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - INTERVAL_MS)
    .refine((time) => time % INTERVAL_MS === 0, '时间未对齐 15m 网格'),
]).rest(z.unknown())
  .refine(([open, high, low, close]) => high >= Math.max(open, close, low) && low <= Math.min(open, close),
    'OHLC 关系不成立');
const responseSchema = z.object({ code: z.literal(0), success: z.literal(true), data: z.array(rowSchema) });
const windowSchema = z.object({
  from: z.number().int().nonnegative(), to: z.number().int().positive(),
}).refine(({ from, to }) => from < to);

export type BinanceWeb3ErrorCode = 'BINANCE_INPUT' | 'BINANCE_HTTP' | 'BINANCE_NETWORK'
  | 'BINANCE_STATUS' | 'BINANCE_VALIDATION' | 'BINANCE_RATE_LIMIT' | 'BINANCE_AUTH' | 'BINANCE_STATE';

/** 只暴露固定说明、HTTP 状态和恢复时间；绝不保留请求、响应、凭据或底层 cause。 */
export class BinanceWeb3Error extends Error {
  constructor(readonly code: BinanceWeb3ErrorCode, message: string,
    readonly httpStatus?: number, readonly retryAt?: number) {
    super(message);
    this.name = 'BinanceWeb3Error';
  }
}

export interface BinanceWeb3CandleResult {
  source: { provider: 'binance'; scope: 'token'; chain: string; ca: string; currency: 'usd'; pool: null };
  candles: Candle[];
  /** 已翻到最早可得数据时为 true；调用方据此停止继续回补。 */
  exhausted: boolean;
}

interface SharedBudget { queue: Promise<void>; lastRequestAt: number; cooldownUntil: number; minGapMs: number }
// 同一凭据的客户端共享单队列（含重试）。键只存摘要，无法从对象检查里读出 key。
const budgets = new Map<string, SharedBudget>();

export interface BinanceWeb3ClientOptions {
  apiKey: string;
  requestsPerMinute?: number;
  retryBaseMs?: number;
  rateLimitStore?: RateLimitStore;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class BinanceWeb3Client {
  readonly #apiKey: string;
  readonly #budget: SharedBudget;
  readonly #retryBaseMs: number;
  readonly #clock: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #rateLimitStore: RateLimitStore | undefined;

  constructor(opts: BinanceWeb3ClientOptions) {
    const rpm = opts.requestsPerMinute ?? DEFAULT_RPM;
    const retryBaseMs = opts.retryBaseMs ?? 1_000;
    if (typeof opts.apiKey !== 'string' || !/^[\x21-\x7e]+$/.test(opts.apiKey)
      || !Number.isFinite(rpm) || rpm <= 0 || !Number.isSafeInteger(Math.ceil(60_000 / rpm))
      || !Number.isSafeInteger(retryBaseMs) || retryBaseMs < 0) {
      throw new BinanceWeb3Error('BINANCE_INPUT', 'Binance Web3 凭据、速率或重试配置无效');
    }
    this.#apiKey = opts.apiKey;
    this.#retryBaseMs = retryBaseMs;
    this.#clock = opts.clock ?? Date.now;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#rateLimitStore = opts.rateLimitStore;
    const key = createHash('sha256').update(opts.apiKey).digest('hex');
    const minGapMs = Math.max(1, Math.ceil(60_000 / rpm));
    let budget = budgets.get(key);
    if (!budget) { budget = { queue: Promise.resolve(), lastRequestAt: -Infinity, cooldownUntil: 0, minGapMs }; budgets.set(key, budget); }
    // 新建更快的客户端不得提高同一已用凭据的预算；提速需由采集 owner 重启配置。
    budget.minGapMs = Math.max(budget.minGapMs, minGapMs);
    this.#budget = budget;
  }

  setRateLimitStore(store: RateLimitStore): void { this.#rateLimitStore = store; }

  #now(): number {
    let now: number;
    try { now = this.#clock(); } catch { throw new BinanceWeb3Error('BINANCE_STATE', 'Binance Web3 时钟读取失败'); }
    if (!Number.isSafeInteger(now) || now < 0) throw new BinanceWeb3Error('BINANCE_STATE', 'Binance Web3 时钟无效');
    return now;
  }

  #storedCooldown(): number {
    try {
      const until = this.#rateLimitStore?.getUntil() ?? 0;
      if (!Number.isSafeInteger(until) || until < 0) throw new Error();
      return until;
    } catch { throw new BinanceWeb3Error('BINANCE_STATE', 'Binance Web3 冷却状态读取失败'); }
  }

  #checkCooldown(): void {
    const until = Math.max(this.#budget.cooldownUntil, this.#storedCooldown());
    this.#budget.cooldownUntil = until;
    if (until > this.#now()) throw new BinanceWeb3Error('BINANCE_RATE_LIMIT', 'Binance Web3 处于限流冷却期', 429, until);
  }

  async #schedule<T>(operation: () => Promise<T>, notBefore: number): Promise<T> {
    // 串行覆盖整个 HTTP 尝试；429 返回时后续排队请求尚未发出。
    const next = this.#budget.queue.then(async () => {
      this.#checkCooldown();
      const target = Math.max(notBefore, this.#budget.lastRequestAt + this.#budget.minGapMs);
      while (target > this.#now()) { await this.#sleep(Math.min(target - this.#now(), 60_000)); this.#checkCooldown(); }
      this.#checkCooldown();
      this.#budget.lastRequestAt = this.#now();
      return operation();
    });
    this.#budget.queue = next.then(() => {}, () => {});
    try { return await next; }
    catch (error) {
      if (error instanceof BinanceWeb3Error) throw error;
      throw new BinanceWeb3Error('BINANCE_STATE', 'Binance Web3 请求队列失败');
    }
  }

  #rateLimited(response: Response): never {
    const now = this.#now();
    const candidates = [unixSecondsToMs(response.headers.get('x-ratelimit-reset')),
      retryAfterToMs(response.headers.get('retry-after'), now)]
      .filter((value): value is number => value !== undefined);
    const until = Math.min(Number.MAX_SAFE_INTEGER,
      Math.max(now, this.#budget.cooldownUntil, this.#storedCooldown(),
        ...(candidates.length ? candidates : [now + UNKNOWN_COOLDOWN_MS])) + RESET_BUFFER_MS);
    this.#budget.cooldownUntil = until;
    try { this.#rateLimitStore?.setUntil(until); }
    catch { throw new BinanceWeb3Error('BINANCE_STATE', 'Binance Web3 冷却状态保存失败', 429, until); }
    throw new BinanceWeb3Error('BINANCE_RATE_LIMIT', 'Binance Web3 限流冷却已记录', 429, until);
  }

  /** 单页请求。after 取更早的数据（OKX 风格：after=更旧，before=更新），省略则取最新一页。 */
  async #page(chainId: string, ca: string, after: number | undefined): Promise<Candle[]> {
    const url = new URL(PATH, HOST);
    url.searchParams.set('binanceChainId', chainId);
    url.searchParams.set('tokenContractAddress', ca);
    url.searchParams.set('bar', '15m');
    url.searchParams.set('limit', String(MAX_LIMIT));
    if (after !== undefined) url.searchParams.set('after', String(after));

    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', redirect: 'error',
        headers: { 'xapi-key': this.#apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000) });
    } catch { throw new BinanceWeb3Error('BINANCE_NETWORK', 'Binance Web3 网络失败或超时'); }

    if (response.status === 429) { await response.body?.cancel().catch(() => {}); this.#rateLimited(response); }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new BinanceWeb3Error('BINANCE_AUTH', 'Binance Web3 鉴权失败', response.status);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new BinanceWeb3Error('BINANCE_HTTP', 'Binance Web3 请求失败', response.status);
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw new BinanceWeb3Error('BINANCE_VALIDATION', 'Binance Web3 响应不是有效 JSON'); }
    // 网关对业务错误也返回 200，必须按 body.code 判定。
    if (body !== null && typeof body === 'object' && 'success' in body && body.success !== true) {
      throw new BinanceWeb3Error('BINANCE_STATUS', 'Binance Web3 返回非成功业务状态', response.status);
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw new BinanceWeb3Error('BINANCE_VALIDATION', 'Binance Web3 K 线响应未通过校验');
    const bars = new Map<number, Candle>();
    for (const row of parsed.data.data) {
      const [open, high, low, close, volume, openTime] = row;
      const previous = bars.get(openTime);
      const candle: Candle = { openTime, open, high, low, close, volume };
      if (previous && (previous.open !== open || previous.high !== high || previous.low !== low
        || previous.close !== close || previous.volume !== volume)) {
        throw new BinanceWeb3Error('BINANCE_VALIDATION', 'Binance Web3 同一时刻存在冲突 K 线');
      }
      bars.set(openTime, candle);
    }
    return [...bars.values()].sort((a, b) => a.openTime - b.openTime);
  }

  /**
   * 取 [from,to) 内已收盘的 15m。单页上限 300 根，窗口更长时按 after 向更早翻页，
   * 最多 MAX_PAGES 页。上游跳过无成交区间，本地绝不补造平价或零量行。
   * USD token 序列未绑定任何固定池，不能与 Gecko 的 pool 历史混用。
   */
  async getCandles15m(network: string, ca: string, range: { from: number; to: number }): Promise<BinanceWeb3CandleResult> {
    const chainId = resolveBinanceChain(network);
    const parsedRange = windowSchema.safeParse(range);
    const trimmed = typeof ca === 'string' ? ca.trim() : '';
    const validAddress = chainId === 'CT_501'
      ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed) : /^0x[\da-f]{40}$/i.test(trimmed);
    if (!chainId || !validAddress || !parsedRange.success) {
      throw new BinanceWeb3Error('BINANCE_INPUT', 'Binance Web3 链、代币地址或毫秒窗口无效');
    }
    const address = canonicalCa(trimmed);
    const { from, to } = parsedRange.data;
    const closedBefore = Math.min(this.#now(), to);
    const collected = new Map<number, Candle>();
    let cursor: number | undefined;
    let exhausted = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      let bars: Candle[] = [];
      let notBefore = 0;
      for (let attempt = 0; ; attempt++) {
        try { bars = await this.#schedule(() => this.#page(chainId, address, cursor), notBefore); break; }
        catch (error) {
          const retryable = error instanceof BinanceWeb3Error && (error.code === 'BINANCE_NETWORK'
            || (error.code === 'BINANCE_HTTP' && error.httpStatus !== undefined
              && error.httpStatus >= 500 && error.httpStatus < 600));
          if (!retryable || attempt === MAX_RETRIES) throw error;
          notBefore = this.#now() + this.#retryBaseMs * 2 ** attempt;
        }
      }
      if (!bars.length) { exhausted = true; break; }
      for (const bar of bars) collected.set(bar.openTime, bar);
      const oldest = bars[0]!.openTime;
      // 上游已给到窗口起点之前，或本页不足一整页，说明没有更早数据可取。
      if (oldest <= from || bars.length < MAX_LIMIT) { exhausted = oldest <= from ? false : true; break; }
      if (cursor !== undefined && oldest >= cursor) { exhausted = true; break; }   // 游标未推进，防止死循环
      cursor = oldest;
    }

    return {
      source: { provider: 'binance', scope: 'token', chain: network.trim().toLowerCase(), ca: address, currency: 'usd', pool: null },
      candles: [...collected.values()]
        .filter((bar) => bar.openTime >= from && bar.openTime < to && bar.openTime + INTERVAL_MS <= closedBefore)
        .sort((a, b) => a.openTime - b.openTime),
      exhausted,
    };
  }
}

function unixSecondsToMs(value: string | null): number | undefined {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const ms = Number(value) * 1000;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}
function retryAfterToMs(value: string | null, now: number): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const text = value.trim();
  const until = /^\d+(?:\.\d+)?$/.test(text) ? now + Number(text) * 1000 : Date.parse(text);
  return Number.isSafeInteger(until) && until >= 0 ? until : undefined;
}
