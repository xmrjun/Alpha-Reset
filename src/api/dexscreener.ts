import { z } from 'zod';
import { canonicalCa } from '../addresses.js';
import type { DexSnapshot } from '../types.js';

/**
 * DexScreener 官方 API 客户端 —— 直连，不经二娃，因此不消耗二娃配额、
 * 也不受其账户级限流影响（见 docs/03 §4）。
 *
 * 官方文档：https://docs.dexscreener.com/api/reference
 * - 批量上限 30 个地址（实测：传 50/100 只返回 30；旧端点传 40 直接 400）
 * - 限流 60 req/min，无需 API key
 */
export const DEX_BATCH_SIZE = 30;
const RATE_LIMIT_PER_MIN = 60;

const pairSchema = z.object({
  chainId: z.string().optional(),
  pairAddress: z.string().optional(),
  baseToken: z.object({ address: z.string() }).optional(),
  priceUsd: z.union([z.string(), z.number()]).nullish(),
  marketCap: z.number().nullish(),
  fdv: z.number().nullish(),
  liquidity: z.object({ usd: z.number().nullish() }).nullish(),
  priceChange: z.object({
    m5: z.number().nullish(), h1: z.number().nullish(),
    h6: z.number().nullish(), h24: z.number().nullish(),
  }).nullish(),
  pairCreatedAt: z.number().nullish(),
}).passthrough();

const listSchema = z.array(pairSchema);
const legacySchema = z.object({ pairs: z.array(pairSchema).nullish() });

export class DexScreenerError extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
    this.name = 'DexScreenerError';
  }
}

const toNumber = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};

/** 同一 token 的多个交易对：按美元流动性取主交易对；上市时间取最早的那个 */
function fold(pairs: z.infer<typeof pairSchema>[]): DexSnapshot {
  const main = [...pairs].sort((a, b) =>
    (b.liquidity?.usd ?? -1) - (a.liquidity?.usd ?? -1)
    || (a.pairAddress ?? '').localeCompare(b.pairAddress ?? ''))[0];
  const created = pairs.flatMap((pair) => typeof pair.pairCreatedAt === 'number' ? [pair.pairCreatedAt] : []);
  return {
    priceUsd: toNumber(main?.priceUsd),
    marketCap: toNumber(main?.marketCap) ?? toNumber(main?.fdv),
    liquidityUsd: toNumber(main?.liquidity?.usd),
    priceChange: {
      m5: toNumber(main?.priceChange?.m5), h1: toNumber(main?.priceChange?.h1),
      h6: toNumber(main?.priceChange?.h6), h24: toNumber(main?.priceChange?.h24),
    },
    pairCreatedAt: created.length > 0 ? Math.min(...created) : null,
  };
}

export function chunk<T>(items: T[], size = DEX_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class DexScreenerClient {
  readonly #baseUrl: string;
  readonly #minGapMs: number;
  #lastRequestAt = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(opts: { baseUrl?: string; requestsPerMinute?: number } = {}) {
    this.#baseUrl = opts.baseUrl ?? 'https://api.dexscreener.com';
    // 官方限流 60 req/min，留出余量按均匀间隔发送
    this.#minGapMs = Math.ceil(60_000 / Math.min(opts.requestsPerMinute ?? RATE_LIMIT_PER_MIN, RATE_LIMIT_PER_MIN));
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

  async #fetchJson(path: string): Promise<unknown> {
    await this.#throttle();
    const response = await fetch(new URL(path, this.#baseUrl), {
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new DexScreenerError(`DexScreener 请求失败（${response.status}）`, response.status);
    return response.json();
  }

  /**
   * 批量查询一组地址。`chain` 为空时走免 chainId 的旧端点。
   * 返回以 canonicalCa 为键；查不到的地址不会出现在结果中。
   */
  async getBatch(chain: string | null, addresses: string[]): Promise<Map<string, DexSnapshot>> {
    const result = new Map<string, DexSnapshot>();
    const wanted = new Set(addresses.map(canonicalCa));
    for (const batch of chunk(addresses)) {
      const joined = batch.map((ca) => encodeURIComponent(ca)).join(',');
      const raw = chain
        ? await this.#fetchJson(`/tokens/v1/${encodeURIComponent(chain)}/${joined}`)
        : await this.#fetchJson(`/latest/dex/tokens/${joined}`);
      const pairs = chain
        ? listSchema.parse(raw)
        : (legacySchema.parse(raw).pairs ?? []);
      const grouped = new Map<string, z.infer<typeof pairSchema>[]>();
      for (const pair of pairs) {
        const address = pair.baseToken?.address;
        if (!address) continue;
        const key = canonicalCa(address);
        if (!wanted.has(key)) continue;
        (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(pair);
      }
      for (const [ca, list] of grouped) result.set(ca, fold(list));
    }
    return result;
  }

  /** 按链分组后批量查询整个池子 */
  async getAll(items: { ca: string; chain: string | null }[]): Promise<Map<string, DexSnapshot>> {
    const byChain = new Map<string | null, string[]>();
    for (const item of items) {
      const key = item.chain?.trim() || null;
      (byChain.get(key) ?? byChain.set(key, []).get(key)!).push(item.ca);
    }
    const merged = new Map<string, DexSnapshot>();
    for (const [chain, addresses] of byChain) {
      for (const [ca, snapshot] of await this.getBatch(chain, addresses)) merged.set(ca, snapshot);
    }
    return merged;
  }
}
