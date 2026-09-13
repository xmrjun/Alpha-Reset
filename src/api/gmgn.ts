import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalCa } from '../addresses.js';
import type { Candle } from '../types.js';
import type { RateLimitStore } from './erwa.js';

const HOST = 'https://openapi.gmgn.ai';
const INTERVAL_MS = 15 * 60_000;
const DEFAULT_RPM = 30;
const MAX_RETRIES = 2;
const UNKNOWN_COOLDOWN_MS = 60_000;
const RESET_BUFFER_MS = 1_000;

const chains = ['sol', 'bsc', 'base', 'eth', 'arbitrum', 'hyperevm', 'robinhood', 'arc', 'stable'] as const;
export type GmgnChain = typeof chains[number];
const aliases: Readonly<Record<string, GmgnChain>> = { solana: 'sol', ethereum: 'eth' };

/** CLI 接受的链不代表每个账号已获对应行情权限；服务端拒绝仍须显式处理。 */
export function resolveGmgnChain(chain: string): GmgnChain | null {
  const normalized = chain.trim().toLowerCase();
  if (Object.hasOwn(aliases, normalized)) return aliases[normalized]!;
  return chains.find((candidate) => candidate === normalized) ?? null;
}

const decimal = z.string().regex(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/)
  .refine((value) => Number(value) !== 0 || !/[1-9]/.test(value.split(/[eE]/)[0]!))
  .transform(Number).pipe(z.number().finite());
const price = decimal.pipe(z.number().positive());
const rowSchema = z.object({
  time: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - INTERVAL_MS)
    .refine((time) => time % INTERVAL_MS === 0),
  open: price, high: price, low: price, close: price,
  volume: decimal.pipe(z.number().nonnegative()),
}).refine((row) => row.high >= Math.max(row.open, row.close, row.low)
  && row.low <= Math.min(row.open, row.close));
const responseSchema = z.object({ code: z.literal(0), data: z.object({ list: z.array(rowSchema) }) });
const windowSchema = z.object({
  from: z.number().int().nonnegative(), to: z.number().int().positive(),
}).refine(({ from, to }) => from < to);

export type GmgnErrorCode = 'GMGN_INPUT' | 'GMGN_HTTP' | 'GMGN_NETWORK' | 'GMGN_STATUS'
  | 'GMGN_VALIDATION' | 'GMGN_RATE_LIMIT' | 'GMGN_STATE';

/** 只暴露固定说明、HTTP 状态和恢复时间，绝不保留请求、响应、凭据或底层 cause。 */
export class GmgnError extends Error {
  constructor(readonly code: GmgnErrorCode, message: string,
    readonly httpStatus?: number, readonly retryAt?: number) {
    super(message);
    this.name = 'GmgnError';
  }
}

export interface GmgnCandleResult {
  source: {
    provider: 'gmgn'; scope: 'token'; chain: GmgnChain; ca: string;
    currency: 'usd'; pool: null;
  };
  candles: Candle[];
}

interface SharedBudget {
  queue: Promise<void>;
  lastRequestAt: number;
  cooldownUntil: number;
  minGapMs: number;
}

// 同一账号的客户端共享单队列，包括重试。键只保存摘要，不能通过对象检查读出 API Key。
// 跨进程冷却由调用方提供的 GMGN 专属 RateLimitStore 维持；多进程发请求仍需单一采集 owner。
const budgets = new Map<string, SharedBudget>();

export interface GmgnClientOptions {
  apiKey: string;
  requestsPerMinute?: number;
  retryBaseMs?: number;
  rateLimitStore?: RateLimitStore;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class GmgnClient {
  readonly #apiKey: string;
  readonly #budget: SharedBudget;
  readonly #retryBaseMs: number;
  readonly #clock: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #rateLimitStore: RateLimitStore | undefined;

  constructor(opts: GmgnClientOptions) {
    const rpm = opts.requestsPerMinute ?? DEFAULT_RPM;
    const retryBaseMs = opts.retryBaseMs ?? 1_000;
    if (typeof opts.apiKey !== 'string' || !/^[\x21-\x7e]+$/.test(opts.apiKey)
      || !Number.isFinite(rpm) || rpm <= 0 || !Number.isSafeInteger(Math.ceil(60_000 / rpm))
      || !Number.isSafeInteger(retryBaseMs) || retryBaseMs < 0) {
      throw new GmgnError('GMGN_INPUT', 'GMGN 凭据、速率或重试配置无效');
    }
    this.#apiKey = opts.apiKey;
    this.#retryBaseMs = retryBaseMs;
    this.#clock = opts.clock ?? Date.now;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#rateLimitStore = opts.rateLimitStore;
    const key = createHash('sha256').update(opts.apiKey).digest('hex');
    const minGapMs = Math.max(1, Math.ceil(60_000 / rpm));
    let budget = budgets.get(key);
    if (!budget) {
      budget = { queue: Promise.resolve(), lastRequestAt: -Infinity, cooldownUntil: 0, minGapMs };
      budgets.set(key, budget);
    }
    // 新建更快客户端不得提高同一已用账号的预算；显式提速由采集 owner 重启配置。
    budget.minGapMs = Math.max(budget.minGapMs, minGapMs);
    this.#budget = budget;
  }

  /** 必须使用 GMGN 独立持久键，不能复用 Gecko 或二娃的冷却记录。 */
  setRateLimitStore(store: RateLimitStore): void { this.#rateLimitStore = store; }

  #now(): number {
    let now: number;
    try { now = this.#clock(); } catch { throw new GmgnError('GMGN_STATE', 'GMGN 时钟读取失败'); }
    if (!Number.isSafeInteger(now) || now < 0) throw new GmgnError('GMGN_STATE', 'GMGN 时钟无效');
    return now;
  }

  #storedCooldown(): number {
    try {
      const until = this.#rateLimitStore?.getUntil() ?? 0;
      if (!Number.isSafeInteger(until) || until < 0) throw new Error();
      return until;
    } catch {
      throw new GmgnError('GMGN_STATE', 'GMGN 冷却状态读取失败');
    }
  }

  #checkCooldown(): void {
    const until = Math.max(this.#budget.cooldownUntil, this.#storedCooldown());
    this.#budget.cooldownUntil = until;
    if (until > this.#now()) {
      throw new GmgnError('GMGN_RATE_LIMIT', 'GMGN 行情处于限流冷却期', 429, until);
    }
  }

  async #schedule<T>(operation: () => Promise<T>, notBefore: number): Promise<T> {
    // 串行覆盖整个 HTTP 尝试，429 返回时后续排队请求还未发出。
    const next = this.#budget.queue.then(async () => {
      this.#checkCooldown();
      const target = Math.max(notBefore, this.#budget.lastRequestAt + this.#budget.minGapMs);
      while (target > this.#now()) {
        await this.#sleep(Math.min(target - this.#now(), 60_000));
        this.#checkCooldown();
      }
      this.#checkCooldown();
      this.#budget.lastRequestAt = this.#now();
      return operation();
    });
    this.#budget.queue = next.then(() => {}, () => {});
    try { return await next; }
    catch (error) {
      if (error instanceof GmgnError) throw error;
      throw new GmgnError('GMGN_STATE', 'GMGN 请求队列失败');
    }
  }

  #rateLimited(response: Response, body: unknown): never {
    const now = this.#now();
    const reset = body !== null && typeof body === 'object' && 'reset_at' in body ? body.reset_at : undefined;
    const candidates = [unixSecondsToMs(response.headers.get('X-RateLimit-Reset')),
      unixSecondsToMs(reset), retryAfterToMs(response.headers.get('Retry-After'), now)]
      .filter((value): value is number => value !== undefined);
    const until = Math.min(Number.MAX_SAFE_INTEGER,
      Math.max(now, this.#budget.cooldownUntil, this.#storedCooldown(),
        ...(candidates.length ? candidates : [now + UNKNOWN_COOLDOWN_MS])) + RESET_BUFFER_MS);
    this.#budget.cooldownUntil = until;
    try { this.#rateLimitStore?.setUntil(until); }
    catch { throw new GmgnError('GMGN_STATE', 'GMGN 冷却状态保存失败', 429, until); }
    throw new GmgnError('GMGN_RATE_LIMIT', 'GMGN 限流冷却已记录', 429, until);
  }

  async #request(chain: GmgnChain, ca: string, range: { from: number; to: number },
    closedBefore: number): Promise<GmgnCandleResult> {
    const url = new URL('/v1/market/token_kline', HOST);
    for (const [key, value] of Object.entries({ chain, address: ca, resolution: '15m',
      from: range.from, to: range.to, timestamp: Math.floor(this.#now() / 1000), client_id: randomUUID() })) {
      url.searchParams.set(key, String(value));
    }
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', redirect: 'error',
        headers: { 'X-APIKEY': this.#apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000) });
    } catch { throw new GmgnError('GMGN_NETWORK', 'GMGN 行情网络失败或超时'); }

    if (response.status === 429) {
      let body: unknown;
      try { body = await response.json(); } catch { await response.body?.cancel().catch(() => {}); }
      this.#rateLimited(response, body);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new GmgnError('GMGN_HTTP', 'GMGN 行情请求失败', response.status);
    }
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new GmgnError('GMGN_VALIDATION', 'GMGN 响应不是有效 JSON'); }
    if (body !== null && typeof body === 'object' && 'code' in body && body.code !== 0) {
      if (body.code === 429 || ('error' in body
        && (body.error === 'RATE_LIMIT_EXCEEDED' || body.error === 'RATE_LIMIT_BANNED'))) {
        this.#rateLimited(response, body);
      }
      throw new GmgnError('GMGN_STATUS', 'GMGN 行情返回非成功业务状态', response.status);
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw new GmgnError('GMGN_VALIDATION', 'GMGN K 线响应未通过校验');
    const bars = new Map<number, Candle>();
    for (const { time, open, high, low, close, volume } of parsed.data.data.list) {
      const previous = bars.get(time);
      if (previous && (previous.open !== open || previous.high !== high || previous.low !== low
        || previous.close !== close || previous.volume !== volume)) {
        throw new GmgnError('GMGN_VALIDATION', 'GMGN 同一时刻存在冲突 K 线');
      }
      bars.set(time, { openTime: time, open, high, low, close, volume });
    }
    return {
      source: { provider: 'gmgn', scope: 'token', chain, ca, currency: 'usd', pool: null },
      candles: [...bars.values()].filter((bar) => bar.openTime >= range.from && bar.openTime < range.to
        && bar.openTime + INTERVAL_MS <= closedBefore).sort((a, b) => a.openTime - b.openTime),
    };
  }

  /**
   * 单次调用仅请求一个明确的毫秒窗口，不分页、不回填、不补造缺失/零量行。
   * 返回 [from,to) 内且在 min(调用开始时刻,to) 前已收盘的 15m；调用方可再按计算 T 收窄。
   * USD token 序列未确认绑定任何固定池，不能与 Gecko pool 历史直接混合。
   */
  async getCandles15m(chain: string, ca: string, range: { from: number; to: number }): Promise<GmgnCandleResult> {
    const resolved = typeof chain === 'string' ? resolveGmgnChain(chain) : undefined;
    const parsedRange = windowSchema.safeParse(range);
    const validAddress = typeof ca === 'string' && (resolved === 'sol'
      ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca.trim()) : /^0x[\da-f]{40}$/i.test(ca.trim()));
    if (!resolved || !validAddress || !parsedRange.success) {
      throw new GmgnError('GMGN_INPUT', 'GMGN 链、代币地址或毫秒窗口无效');
    }
    const address = canonicalCa(ca.trim());
    const closedBefore = Math.min(this.#now(), parsedRange.data.to);
    let notBefore = 0;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.#schedule(() => this.#request(resolved, address, parsedRange.data, closedBefore), notBefore);
      } catch (error) {
        const retryable = error instanceof GmgnError && (error.code === 'GMGN_NETWORK'
          || (error.code === 'GMGN_HTTP' && error.httpStatus !== undefined
            && error.httpStatus >= 500 && error.httpStatus < 600));
        if (!retryable || attempt === MAX_RETRIES) throw error;
        notBefore = this.#now() + this.#retryBaseMs * 2 ** attempt;
      }
    }
    throw new GmgnError('GMGN_NETWORK', 'GMGN 行情重试次数耗尽');
  }
}

function unixSecondsToMs(value: unknown): number | undefined {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) return undefined;
  const ms = Number(value) * 1000;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}

function retryAfterToMs(value: string | null, now: number): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const text = value.trim();
  const until = /^\d+(?:\.\d+)?$/.test(text) ? now + Number(text) * 1000 : Date.parse(text);
  return Number.isSafeInteger(until) && until >= 0 ? until : undefined;
}
