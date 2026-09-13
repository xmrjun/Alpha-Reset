import { z } from 'zod';
import { canonicalCa } from '../addresses.js';
import type { Candle } from '../types.js';
import type { RateLimitStore } from './erwa.js';
import { resolveGeckoNetwork } from './networks.js';

/**
 * 免费 GeckoTerminal OHLCV 接入，15m 数据在本地合成其他周期。
 * 1000 根是单页上限，不能证明已覆盖上市以来全部历史。
 * 官方公共 API 规范为约 10 次/分钟且可能波动；高于 10 的配置仍夹紧到 10。
 * https://api.geckoterminal.com/docs/v2/swagger.json
 */
const RATE_LIMIT_PER_MIN = 10;
const INTERVAL_SECONDS = 15 * 60;
const MAX_INLINE_COOLDOWN_MS = 60_000;
export const MAX_BARS = 1000;

const rowSchema = z.tuple([
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER / 1000)
    .refine((time) => time % INTERVAL_SECONDS === 0),
  z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative(),
  z.number().nonnegative(), z.number().nonnegative(),
]).refine(([, open, high, low, close]) => high >= Math.max(open, close, low)
  && low <= Math.min(open, close)
  // 保留旧行为：全零价格行会被过滤；有正收盘价的行必须有有效 OHLC。
  && (close === 0 || (open > 0 && low > 0)));
const tokenSchema = z.object({ address: z.string().trim().min(1) });
const ohlcvSchema = z.object({
  data: z.object({
    attributes: z.object({ ohlcv_list: z.array(rowSchema) }),
  }),
  meta: z.object({ base: tokenSchema, quote: tokenSchema }).optional(),
});

export type GeckoErrorCode = 'GECKO_INPUT' | 'GECKO_HTTP' | 'GECKO_RATE_LIMIT'
  | 'GECKO_VALIDATION' | 'GECKO_NETWORK';

/** 不携带请求地址、原始响应、底层异常或其他供应商凭据。 */
export class GeckoTerminalError extends Error {
  constructor(
    readonly code: GeckoErrorCode,
    message: string,
    readonly httpStatus?: number,
    readonly retryAt?: number,
  ) {
    super(message);
    this.name = 'GeckoTerminalError';
  }
}

export class GeckoTerminalClient {
  readonly #baseUrl: string;
  readonly #minGapMs: number;
  readonly #retryBaseMs: number;
  readonly #clock: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #lastRequestAt = -Infinity;
  #cooldownUntil = 0;
  #rateLimitStore: RateLimitStore | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(opts: {
    baseUrl?: string;
    requestsPerMinute?: number;
    retryBaseMs?: number;
    clock?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {}) {
    const rpm = opts.requestsPerMinute ?? RATE_LIMIT_PER_MIN;
    const retryBaseMs = opts.retryBaseMs ?? 5_000;
    if (!Number.isFinite(rpm) || rpm <= 0 || !Number.isFinite(retryBaseMs) || retryBaseMs < 0) {
      throw new GeckoTerminalError('GECKO_INPUT', '请求速率或重试间隔无效');
    }
    this.#baseUrl = opts.baseUrl ?? 'https://api.geckoterminal.com';
    this.#minGapMs = Math.ceil(60_000 / Math.min(rpm, RATE_LIMIT_PER_MIN));
    this.#retryBaseMs = retryBaseMs;
    this.#clock = opts.clock ?? Date.now;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** 使用独立的 Gecko 存储键，不能复用二娃的账号级冷却。 */
  setRateLimitStore(store: RateLimitStore): void { this.#rateLimitStore = store; }

  #checkCooldown(): void {
    const until = Math.max(this.#cooldownUntil, this.#rateLimitStore?.getUntil() ?? 0);
    if (until > this.#clock()) {
      throw new GeckoTerminalError('GECKO_RATE_LIMIT', 'K 线 API 处于限流冷却期', 429, until);
    }
  }

  async #throttle(): Promise<void> {
    const next = this.#queue.then(async () => {
      this.#checkCooldown();
      const pause = this.#minGapMs - (this.#clock() - this.#lastRequestAt);
      if (pause > 0) await this.#sleep(pause);
      this.#checkCooldown();
      this.#lastRequestAt = this.#clock();
    });
    this.#queue = next.then(() => {}, () => {});
    return next;
  }

  /**
   * 只接受上游确认的无成交填充行，不对网络失败或缺失区间自行补价。
   * targetCa 明确请求哪一侧的 USD 价格；传入时必须校验响应交易对含该地址。
   * 旧三参数调用保留兼容；生产采集应始终传入目标 CA。
   */
  async getCandles15m(network: string, pool: string, limit = MAX_BARS, targetCa?: string): Promise<Candle[]> {
    const resolvedNetwork = resolveGeckoNetwork(network);
    if (!resolvedNetwork || !pool.trim() || !Number.isSafeInteger(limit) || limit <= 0
      || (targetCa !== undefined && !targetCa.trim())) {
      throw new GeckoTerminalError('GECKO_INPUT', '网络、交易对、目标地址或数量无效');
    }
    const target = targetCa === undefined ? undefined : canonicalCa(targetCa.trim());
    const url = new URL(
      `/api/v2/networks/${encodeURIComponent(resolvedNetwork)}/pools/${encodeURIComponent(pool.trim())}/ohlcv/minute`,
      this.#baseUrl,
    );
    url.searchParams.set('aggregate', '15');
    url.searchParams.set('limit', String(Math.min(limit, MAX_BARS)));
    url.searchParams.set('currency', 'usd');
    url.searchParams.set('include_empty_intervals', 'true');
    if (target !== undefined) url.searchParams.set('token', target);

    // 初次请求和最多三次重试都经统一节流；只重试网络错误、429 和 5xx。
    for (let attempt = 0; attempt <= 3; attempt++) {
      await this.#throttle();
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { Accept: 'application/json;version=20230203' },
          redirect: 'error', signal: AbortSignal.timeout(30_000),
        });
      } catch {
        if (attempt === 3) throw new GeckoTerminalError('GECKO_NETWORK', 'K 线请求网络失败或超时');
        await this.#sleep(this.#retryBaseMs * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
        let delay = this.#retryBaseMs * 2 ** attempt;
        if (response.status === 429) {
          const header = response.headers.get('Retry-After')?.trim();
          const retryAfter = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000
            : header ? Date.parse(header) - this.#clock() : 0;
          if (Number.isFinite(retryAfter)) delay = Math.max(delay, retryAfter);
          this.#cooldownUntil = Math.max(this.#cooldownUntil, this.#clock() + delay,
            this.#rateLimitStore?.getUntil() ?? 0);
          this.#rateLimitStore?.setUntil(this.#cooldownUntil);
          if (this.#cooldownUntil - this.#clock() > MAX_INLINE_COOLDOWN_MS || attempt === 3) {
            throw new GeckoTerminalError('GECKO_RATE_LIMIT', 'K 线限流冷却已记录', 429, this.#cooldownUntil);
          }
        }
        if (retryable && attempt < 3) {
          await this.#sleep(delay);
          continue;
        }
        throw new GeckoTerminalError('GECKO_HTTP', `K 线请求失败（${response.status}）`, response.status);
      }

      let body: unknown;
      try { body = await response.json(); }
      catch {
        await response.body?.cancel().catch(() => {});
        throw new GeckoTerminalError('GECKO_VALIDATION', 'K 线响应不是有效 JSON');
      }
      const parsed = ohlcvSchema.safeParse(body);
      if (!parsed.success) throw new GeckoTerminalError('GECKO_VALIDATION', 'K 线响应未通过校验');
      if (target !== undefined) {
        const meta = parsed.data.meta;
        const matchesBase = meta !== undefined && canonicalCa(meta.base.address) === target;
        const matchesQuote = meta !== undefined && canonicalCa(meta.quote.address) === target;
        if (matchesBase === matchesQuote) {
          throw new GeckoTerminalError('GECKO_VALIDATION', 'K 线响应的目标代币身份无法确认');
        }
      }

      // 上游倒序，去重后统一为升序。相同时间不同数值不能静默挑选任一版本。
      const bars = new Map<number, Candle>();
      for (const [time, open, high, low, close, volume] of parsed.data.data.attributes.ohlcv_list) {
        if (close <= 0) continue;
        const openTime = time * 1000;
        const previous = bars.get(openTime);
        if (previous && (previous.open !== open || previous.high !== high || previous.low !== low
          || previous.close !== close || previous.volume !== volume)) {
          throw new GeckoTerminalError('GECKO_VALIDATION', '同一时刻存在互相冲突的 K 线');
        }
        bars.set(openTime, { openTime, open, high, low, close, volume });
      }
      return [...bars.values()].sort((a, b) => a.openTime - b.openTime);
    }
    throw new GeckoTerminalError('GECKO_NETWORK', 'K 线重试次数耗尽');
  }
}
