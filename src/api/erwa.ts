import { z } from 'zod';
import type { BoardPoolItem, Candle, DexSnapshot, Interval, Range } from '../types.js';
import { canonicalCa } from '../addresses.js';

export const BOARD_LIMITS = { maxDays: 365, maxItems: 200 } as const;

const intervalByRange: Record<Range, Interval> = { '24h': '15m', '7d': '1h', '30d': '4h', '90d': '1d' };
const intervalMs: Record<Interval, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.number().nonnegative();
const displayAmount = z.union([amount, z.string().trim()
  .regex(/^\$?(?:\d+(?:\.\d+)?|\.\d+)[KMBT]?$/i)
  .transform((value) => {
    const text = value.replace(/^\$/, '').toUpperCase();
    const suffix = text.at(-1)!;
    const multiplier: Record<string, number> = { K: 1_000, M: 1_000_000, B: 1_000_000_000, T: 1_000_000_000_000 };
    return multiplier[suffix] === undefined ? Number(text) : Number(text.slice(0, -1)) * multiplier[suffix]!;
  }).pipe(amount)]);
const nullableText = z.string().nullable().optional().transform((value) => value ?? null);
const nullableAmount = amount.nullable().optional().transform((value) => value ?? null);
const mentionTime = z.union([
  timestamp,
  z.iso.datetime({ offset: true }).transform((value) => Date.parse(value)),
  // 上游存在无时区 ISO 时间。时区已实测确认为 UTC：
  // sync 返回的最新记录 create_time 与当时 UTC 时钟仅差数十秒（见 docs/02）。
  // 此前因"不敢猜时区"直接丢弃，导致 ca_pool.latest_mention_time 全表 504 行皆为 NULL。
  z.iso.datetime({ local: true }).transform((value) => Date.parse(`${value}Z`)),
])
  .nullable().optional().transform((value) => value ?? null);

const poolSchema = z.object({
  status: z.literal('ok').optional(),
  cas: z.array(z.object({
    ca: z.string().trim().min(1), symbol: nullableText, chain: nullableText,
    market_cap: displayAmount.nullable().optional(), latest_market_cap: nullableAmount,
    liquidity: nullableAmount, volume_24h: nullableAmount,
    group_name: nullableText, latest_mention_time: mentionTime,
    total_mentions: z.number().int().nonnegative().nullable().optional(),
  })),
});

const candleSchema = z.object({
  open_time: timestamp, open: amount, high: amount, low: amount, close: amount, volume: amount,
}).refine((bar) => bar.high >= Math.max(bar.open, bar.close, bar.low)
  && bar.low <= Math.min(bar.open, bar.close));

const klineSchema = z.object({
  ca: z.string().min(1), range: z.enum(['24h', '7d', '30d', '90d']),
  interval: z.enum(['15m', '1h', '4h', '1d']), status: z.literal('ok'),
  candles: z.array(candleSchema),
});

const usageSchema = z.object({
  status: z.literal('ok').optional(),
  used_today: z.number().int().nonnegative(), remaining_today: z.number().int().nonnegative(),
  daily_limit: z.number().int().positive(),
}).refine((usage) => usage.remaining_today <= usage.daily_limit);

const numeric = z.union([z.number(), z.string().trim()
  .regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/).transform(Number)]).pipe(z.number());
const dexAmount = numeric.pipe(amount).nullable().optional();
const dexChange = numeric.nullable().optional();
const dexSchema = z.object({
  ca: z.string().optional(),
  pairs: z.array(z.object({
    pairAddress: z.string().optional(), chainId: z.string().optional(), baseToken: z.object({ address: z.string() }).optional(),
    priceUsd: dexAmount, marketCap: dexAmount, fdv: dexAmount,
    liquidity: z.object({ usd: dexAmount }).nullable().optional(),
    priceChange: z.object({ m5: dexChange, h1: dexChange, h6: dexChange, h24: dexChange }).nullable().optional(),
    pairCreatedAt: timestamp.nullable().optional(),
  })).nullable(),
});

export interface RateLimitStore {
  getUntil(): number;
  setUntil(until: number): void;
}

export type ErwaErrorCode = 'ERWA_CONFIG' | 'ERWA_INPUT' | 'ERWA_HTTP'
  | 'ERWA_NETWORK' | 'ERWA_STATUS' | 'ERWA_VALIDATION' | 'ERWA_COOLDOWN';

/** 只保留固定错误说明及 HTTP 状态；不携带请求头、原始响应或底层 cause。 */
export class ErwaError extends Error {
  constructor(
    readonly code: ErwaErrorCode,
    message: string,
    readonly httpStatus?: number,
    readonly retryAt?: number,
  ) {
    super(message);
    this.name = 'ErwaError';
  }
}

function validated<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new ErwaError('ERWA_VALIDATION', 'API 响应未通过校验');
  return result.data;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ErwaClient {
  #baseUrl: URL;
  #token: string;
  #onCall: (() => void) | undefined;
  #queue: Promise<void> = Promise.resolve();
  #startQueue: Promise<void> = Promise.resolve();
  #lastRequestAt = -Infinity;
  #dexActive = 0;
  #dexWaiting: (() => void)[] = [];
  #cooldownUntil = 0;
  #rateLimitStore: RateLimitStore | undefined;

  constructor(opts: { baseUrl: string; token: string; onCall?: () => void }) {
    let base: URL;
    try { base = new URL(opts.baseUrl); }
    catch { throw new ErwaError('ERWA_CONFIG', 'API 地址无效'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
      || !opts.token.trim() || /[\r\n]/.test(opts.token)) {
      throw new ErwaError('ERWA_CONFIG', 'API 地址或认证配置无效');
    }
    this.#baseUrl = base;
    this.#token = opts.token;
    this.#onCall = opts.onCall;
  }

  async getBoardSummary(p: { groupName: string; days?: number; limit?: number }): Promise<BoardPoolItem[]> {
    const input = z.object({ groupName: z.string().trim().min(1),
      days: z.number().int().min(1).max(BOARD_LIMITS.maxDays).default(1),
      limit: z.number().int().min(1).default(60).transform((limit) => Math.min(limit, BOARD_LIMITS.maxItems)),
    }).safeParse(p);
    if (!input.success) throw new ErwaError('ERWA_INPUT', '观察组查询参数无效');
    const query = new URLSearchParams({ group_name: input.data.groupName,
      days: String(input.data.days), limit: String(input.data.limit) });
    const body = validated(poolSchema, await this.#request(`/api/v1/group_ca/board/summary?${query}`));
    return body.cas.map((item) => ({ ca: canonicalCa(item.ca), symbol: item.symbol, chain: item.chain,
      marketCap: item.latest_market_cap ?? item.market_cap ?? null,
      liquidity: item.liquidity, volume24h: item.volume_24h,
      groupName: item.group_name, latestMentionTime: item.latest_mention_time, totalMentions: item.total_mentions ?? null }));
  }

  async getKline(ca: string, range: Range): Promise<{ interval: Interval; candles: Candle[]; status: string }> {
    if (!ca.trim() || !Object.hasOwn(intervalByRange, range)) {
      throw new ErwaError('ERWA_INPUT', 'K 线查询参数无效');
    }
    const body = validated(klineSchema, await this.#request(
      `/api/v1/group_ca/board/ca/${encodeURIComponent(ca)}/kline?range=${encodeURIComponent(range)}`));
    if (canonicalCa(body.ca) !== canonicalCa(ca) || body.range !== range || body.interval !== intervalByRange[range]
      || body.candles.some((bar) => bar.open_time % intervalMs[body.interval] !== 0)) {
      throw new ErwaError('ERWA_VALIDATION', 'K 线标的、周期或时间边界不匹配');
    }
    const candles = new Map<number, Candle>();
    for (const bar of body.candles) {
      candles.set(bar.open_time, { openTime: bar.open_time, open: bar.open, high: bar.high,
        low: bar.low, close: bar.close, volume: bar.volume });
    }
    return { interval: body.interval, status: body.status,
      candles: [...candles.values()].sort((a, b) => a.openTime - b.openTime) };
  }

  async getTokenUsage(): Promise<{ usedToday: number; remainingToday: number; dailyLimit: number }> {
    const usage = validated(usageSchema, await this.#request('/api/v1/token/usage'));
    return { usedToday: usage.used_today, remainingToday: usage.remaining_today, dailyLimit: usage.daily_limit };
  }

  /** 运行时注入持久化冷却；默认仍在本客户端内共享冷却。 */
  setRateLimitStore(store: RateLimitStore): void { this.#rateLimitStore = store; }

  async getDexScreener(ca: string): Promise<DexSnapshot> {
    if (!ca.trim()) throw new ErwaError('ERWA_INPUT', 'DexScreener 查询参数无效');
    if (this.#dexActive >= 2) await new Promise<void>((resolve) => this.#dexWaiting.push(resolve));
    else this.#dexActive++;
    try {
      const body = validated(dexSchema, await this.#send(`/api/v1/binance/dexscreener/${encodeURIComponent(ca)}`, false));
      if (body.ca !== undefined && canonicalCa(body.ca) !== canonicalCa(ca)) {
        throw new ErwaError('ERWA_VALIDATION', 'DexScreener 标的不匹配');
      }
      const pairs = (body.pairs ?? []).filter((pair) => !pair.baseToken || canonicalCa(pair.baseToken.address) === canonicalCa(ca));
      // 动态价格与涨跌幅必须来自同一个交易对；按美元流动性选主交易对。
      const main = [...pairs].sort((a, b) => (b.liquidity?.usd ?? -1) - (a.liquidity?.usd ?? -1)
        || (a.pairAddress ?? '').localeCompare(b.pairAddress ?? ''))[0];
      const created = pairs.flatMap((pair) => pair.pairCreatedAt == null ? [] : [pair.pairCreatedAt]);
      return { pairAddress: main?.pairAddress ?? null, chainId: main?.chainId ?? null,
        priceUsd: main?.priceUsd ?? null, marketCap: main?.marketCap ?? main?.fdv ?? null,
        liquidityUsd: main?.liquidity?.usd ?? null,
        priceChange: { m5: main?.priceChange?.m5 ?? null, h1: main?.priceChange?.h1 ?? null,
          h6: main?.priceChange?.h6 ?? null, h24: main?.priceChange?.h24 ?? null },
        pairCreatedAt: created.length ? Math.min(...created) : null };
    } finally {
      const next = this.#dexWaiting.shift();
      if (next) next(); else this.#dexActive--;
    }
  }

  #request(path: string): Promise<unknown> {
    // 同一客户端串行调度，失败不阻塞后续请求；包括重试在内，最多每秒 5 次。
    const result = this.#queue.then(() => this.#send(path, true));
    this.#queue = result.then(() => {}, () => {});
    return result;
  }

  #checkCooldown(): void {
    const until = Math.max(this.#cooldownUntil, this.#rateLimitStore?.getUntil() ?? 0);
    if (until > Date.now()) throw new ErwaError('ERWA_COOLDOWN', 'API 处于限流冷却期', 429, until);
  }

  async #beforeSend(authenticated: boolean): Promise<void> {
    const start = this.#startQueue.then(async () => {
      this.#checkCooldown();
      const pause = 200 - (Date.now() - this.#lastRequestAt);
      if (pause > 0) await wait(pause);
      this.#checkCooldown();
      if (authenticated) this.#onCall?.();
      this.#lastRequestAt = Date.now();
    });
    this.#startQueue = start.then(() => {}, () => {});
    return start;
  }

  async #send(path: string, authenticated: boolean): Promise<unknown> {
    const url = new URL(path, this.#baseUrl);
    for (let attempt = 0; attempt <= 3; attempt++) {
      await this.#beforeSend(authenticated);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { ...(authenticated ? { Authorization: `Bearer ${this.#token}` } : {}), Accept: 'application/json' },
          signal: AbortSignal.timeout(authenticated ? 15_000 : 60_000), redirect: 'error',
        });
      } catch {
        throw new ErwaError('ERWA_NETWORK', 'API 网络请求失败或超时');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
        let delay = 500 * 2 ** attempt;
        if (response.status === 429) {
          const header = response.headers.get('Retry-After')?.trim();
          const retryAfter = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000
            : header ? Date.parse(header) - Date.now() : 0;
          if (Number.isFinite(retryAfter)) delay = Math.max(delay, retryAfter);
          this.#cooldownUntil = Math.max(this.#cooldownUntil, Date.now() + delay);
          this.#rateLimitStore?.setUntil(this.#cooldownUntil);
          if (delay > 60_000) throw new ErwaError('ERWA_COOLDOWN', 'API 限流冷却已持久化', 429, this.#cooldownUntil);
        }
        if (retryable && attempt < 3) {
          await wait(delay);
          continue;
        }
        throw new ErwaError('ERWA_HTTP', `API HTTP 请求失败（${response.status}）`, response.status);
      }

      let body: unknown;
      try { body = await response.json(); }
      catch { throw new ErwaError('ERWA_VALIDATION', 'API 响应不是有效 JSON'); }
      const status = validated(z.object({ status: z.string().optional() }), body).status;
      if (status !== undefined && status !== 'ok') {
        throw new ErwaError('ERWA_STATUS', 'API 返回非 ok 业务状态');
      }
      return body;
    }
    throw new ErwaError('ERWA_HTTP', 'API 重试次数耗尽');
  }
}
