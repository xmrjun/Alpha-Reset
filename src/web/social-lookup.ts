import { assessSocial, type SocialPost, type SocialQuality } from '../indicators/social-quality.js';
import { AgentToolError } from './agent-tools.js';

/**
 * 社交面查询的预算闸与缓存。
 *
 * 这是唯一一个会花钱的 agent 工具（其余都只读本地库），所以三道闸：
 * 1. 同一个合约缓存若干分钟 —— 重复提问不重复付费，也不计入配额；
 * 2. 全局日上限 —— 封顶整体开销；
 * 3. 单访客日上限 —— 一个人刷不完所有人的额度。
 *
 * 额度判断全部发生在请求上游之前：拒绝时一分钱都不该花出去。
 */

interface SearchLike {
  searchMentions(query: string): Promise<{
    readonly posts: readonly SocialPost[];
    readonly costUsd: number;
    readonly skipped: number;
  }>;
}

export interface SocialLookupResult {
  readonly quality: SocialQuality;
  readonly cached: boolean;
  readonly usedToday: number;
  readonly dailyLimit: number;
  readonly costUsd: number;
}

export interface SocialLookupOptions {
  readonly client: SearchLike | null;
  readonly clock: () => number;
  readonly dailyLimit?: number;
  readonly perClientLimit?: number;
  readonly cacheMs?: number;
}

const MAX_CACHE_ENTRIES = 500;

export class SocialLookup {
  readonly #client: SearchLike | null;
  readonly #clock: () => number;
  readonly #dailyLimit: number;
  readonly #perClientLimit: number;
  readonly #cacheMs: number;

  readonly #cache = new Map<string, { at: number; quality: SocialQuality; costUsd: number }>();
  readonly #perClient = new Map<string, number>();
  /** 同一个合约正在查时复用那次请求：否则并发提问会把同一份数据买很多遍。 */
  readonly #inflight = new Map<string, Promise<SocialLookupResult>>();
  #day = '';
  #used = 0;

  constructor(options: SocialLookupOptions) {
    this.#client = options.client;
    this.#clock = options.clock;
    this.#dailyLimit = options.dailyLimit ?? 2000;
    this.#perClientLimit = options.perClientLimit ?? 50;
    this.#cacheMs = options.cacheMs ?? 600_000;
  }

  get configured(): boolean {
    return this.#client !== null;
  }

  async check(ca: string, clientId: string): Promise<SocialLookupResult> {
    if (!this.#client) throw new AgentToolError('NOT_CONFIGURED', '本站未配置社交数据源');

    const now = this.#clock();
    this.#rollDay(now);

    const hit = this.#cache.get(ca);
    if (hit && now - hit.at < this.#cacheMs) {
      return { quality: hit.quality, cached: true, costUsd: 0,
        usedToday: this.#used, dailyLimit: this.#dailyLimit };
    }

    const pending = this.#inflight.get(ca);
    if (pending) return pending;

    // 两道闸都在请求之前判，超限时不产生任何费用。
    if (this.#used >= this.#dailyLimit) {
      throw new AgentToolError('BUDGET_EXHAUSTED', '今日社交查询额度已用完，明天再试');
    }
    const usedByClient = this.#perClient.get(clientId) ?? 0;
    if (usedByClient >= this.#perClientLimit) {
      throw new AgentToolError('BUDGET_EXHAUSTED', '你今天的社交查询次数已用完');
    }

    // 额度必须在 await 之前就占住。判断在前、自增在后的话，N 个并发请求会在第一个
    // 自增发生之前全部通过检查，上限就变成了攻击者能打出多少并发。
    this.#used += 1;
    this.#perClient.set(clientId, usedByClient + 1);

    const task = (async (): Promise<SocialLookupResult> => {
      try {
        const { posts, costUsd } = await this.#client!.searchMentions(ca);
        const quality = assessSocial(posts);
        this.#remember(ca, { at: now, quality, costUsd });
        return { quality, cached: false, costUsd, usedToday: this.#used, dailyLimit: this.#dailyLimit };
      } catch (error) {
        // 上游故障不该白吃一次额度。
        this.#used -= 1;
        this.#perClient.set(clientId, usedByClient);
        throw error;
      } finally {
        this.#inflight.delete(ca);
      }
    })();
    this.#inflight.set(ca, task);
    return task;
  }

  #remember(ca: string, entry: { at: number; quality: SocialQuality; costUsd: number }): void {
    if (this.#cache.size >= MAX_CACHE_ENTRIES) {
      // Map 保持插入顺序，删最早的那条即可，不必额外维护 LRU。
      const oldest = this.#cache.keys().next();
      if (!oldest.done) this.#cache.delete(oldest.value);
    }
    this.#cache.set(ca, entry);
  }

  /** 按 UTC 自然日切；跨日把全局与单人计数一起清零。 */
  #rollDay(now: number): void {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day === this.#day) return;
    this.#day = day;
    this.#used = 0;
    this.#perClient.clear();
  }
}
