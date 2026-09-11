import { z } from 'zod';
import type { Candle } from '../types.js';

/**
 * GeckoTerminal OHLCV 客户端 —— K 线的主数据源。
 *
 * 为什么不用二娃的 K 线（docs/03 §2 有完整对比）：
 * - 二娃按链有无数据：bsc/solana/ethereum/base 有，**robinhood（池中最多）、
 *   xlayer/hyperevm/tron/avalanche 完全没有**，而 GeckoTerminal 连 robinhood 都覆盖
 * - 历史深度：15m 给 1000 根 ≈ 10.5 天，二娃只有 96 根 = 24 小时。
 *   这是 A3.1「30m 历史新高」能否成立的关键 —— 24 小时恰好等于 48 根 30m，
 *   会让 A3.1 与 A3.2（最近 48bar 新高）永远同时触发，两条规则塌缩成一条
 * - 免费、不占二娃的每日额度
 *
 * 文档：https://www.geckoterminal.com/dex-api
 * 限流：免费档 30 req/min，故默认 2 秒一次均匀发送。
 */
const RATE_LIMIT_PER_MIN = 30;
export const MAX_BARS = 1000;

const ohlcvSchema = z.object({
  data: z.object({
    attributes: z.object({
      // [ 秒级时间戳, open, high, low, close, volume ]
      ohlcv_list: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])),
    }),
  }),
});

export type GeckoErrorCode = 'GECKO_INPUT' | 'GECKO_HTTP' | 'GECKO_RATE_LIMIT'
  | 'GECKO_VALIDATION' | 'GECKO_NETWORK';

export class GeckoTerminalError extends Error {
  constructor(readonly code: GeckoErrorCode, message: string, readonly httpStatus?: number) {
    super(message);
    this.name = 'GeckoTerminalError';
  }
}

export class GeckoTerminalClient {
  readonly #baseUrl: string;
  readonly #minGapMs: number;
  readonly #retryBaseMs: number;
  #lastRequestAt = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(opts: { baseUrl?: string; requestsPerMinute?: number; retryBaseMs?: number } = {}) {
    this.#baseUrl = opts.baseUrl ?? 'https://api.geckoterminal.com';
    this.#minGapMs = Math.ceil(60_000 / Math.min(opts.requestsPerMinute ?? RATE_LIMIT_PER_MIN, RATE_LIMIT_PER_MIN));
    this.#retryBaseMs = opts.retryBaseMs ?? 5_000;
  }

  async #throttle(): Promise<void> {
    const next = this.#queue.then(async () => {
      const pause = this.#minGapMs - (Date.now() - this.#lastRequestAt);
      if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
      this.#lastRequestAt = Date.now();
    });
    this.#queue = next.then(() => {}, () => {});
    return next;
  }

  /**
   * 拉 15 分钟 K 线。只拉这一个周期，30m/1h/4h 由 `aggregateCandles` 本地合成 ——
   * 每个 CA 一次请求，132 个 CA 约 4.4 分钟，远低于 30 分钟的轮询间隔。
   */
  async getCandles15m(network: string, pool: string, limit = MAX_BARS): Promise<Candle[]> {
    if (!network.trim() || !pool.trim()) throw new GeckoTerminalError('GECKO_INPUT', '网络或交易对为空');
    await this.#throttle();
    const url = new URL(
      `/api/v2/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(pool)}/ohlcv/minute`,
      this.#baseUrl,
    );
    url.searchParams.set('aggregate', '15');
    url.searchParams.set('limit', String(Math.min(limit, MAX_BARS)));
    // 429 要退避重试而非直接放弃：单纯降速无法覆盖突发，
    // 且一个 CA 拉不到就会整档掉出 RPS 排名（覆盖率阈值判定）。
    let response: Response | undefined;
    for (let attempt = 0; attempt <= 3; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.#retryBaseMs * 2 ** (attempt - 1)));
        await this.#throttle();
      }
      try { response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
      catch {
        if (attempt === 3) throw new GeckoTerminalError('GECKO_NETWORK', 'K 线请求网络失败或超时');
        continue;
      }
      if (response.status !== 429) break;
      if (attempt === 3) throw new GeckoTerminalError('GECKO_RATE_LIMIT', 'K 线请求持续被限流', 429);
    }
    if (!response) throw new GeckoTerminalError('GECKO_NETWORK', 'K 线请求无响应');
    if (!response.ok) {
      throw new GeckoTerminalError('GECKO_HTTP', `K 线请求失败（${response.status}）`, response.status);
    }
    const parsed = ohlcvSchema.safeParse(await response.json());
    if (!parsed.success) throw new GeckoTerminalError('GECKO_VALIDATION', 'K 线响应未通过校验');
    // 上游按时间倒序返回；统一成升序，并把秒级时间戳转毫秒
    return parsed.data.data.attributes.ohlcv_list
      .map(([time, open, high, low, close, volume]) => ({
        openTime: time * 1000, open, high, low, close, volume,
      }))
      .filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
      .sort((a, b) => a.openTime - b.openTime);
  }
}
