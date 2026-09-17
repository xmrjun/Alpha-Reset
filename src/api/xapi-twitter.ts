import { z } from 'zod';
import type { SocialPost } from '../indicators/social-quality.js';

/**
 * 通过 xapi 网关查 X(Twitter) 上对某个代币的提及。
 *
 * 端点选的是 api 类型的 advanced_search 而不是 capability 的 twitter.search：
 * 前者返回的作者对象字段多得多（fast_followers_count / default_profile_image /
 * bookmark_count / community_note），刷量判定要用的信号都在里面。
 *
 * 凭据只从 process.env 取并走请求头 —— 网关和 nginx 都会把 URL 写进访问日志，
 * key 进 query string 等于明文落盘。
 */

const ENDPOINT = 'https://twitterxapi.p.xapi.to/twitter/advanced_search';
const DEFAULT_TIMEOUT_MS = 25_000;

export class XapiError extends Error {
  override readonly name = 'XapiError';
  constructor(readonly code: 'UPSTREAM_FAILED' | 'BAD_SHAPE' | 'NO_KEY', message: string) {
    super(message);
  }
}

/** 上游把计数字段一会儿发数字一会儿发字符串（view_count 实测是 "30"），统一收成数字。 */
const count = z.union([z.number(), z.string()]).nullish().transform((value) => {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
});

/** 上游字段会变，一律 loose 解析：只挑判定要用的，其余原样忽略。 */
const userSchema = z.looseObject({
  screen_name: z.string(),
  followers_count: count,
  friends_count: count,
  following_count: count,
  statuses_count: count,
  description: z.string().nullish(),
  created_at: z.string(),
  is_blue_verified: z.boolean().nullish(),
  is_verified: z.boolean().nullish(),
});

const tweetSchema = z.looseObject({
  tweet_id: z.string(),
  text: z.string().nullish(),
  full_text: z.string().nullish(),
  view_count: count,
  favorite_count: count,
  retweet_count: count,
  created_at: z.string(),
  urls: z.array(z.string()).nullish(),
  user: userSchema,
});

const responseSchema = z.looseObject({ data: z.array(z.unknown()) });

/** 单条脏数据不该让整次查询失败：解析不了就丢掉，由调用方看 skipped 计数。 */
function toPost(raw: unknown): SocialPost | null {
  const parsed = tweetSchema.safeParse(raw);
  if (!parsed.success) return null;
  const tweet = parsed.data;
  const createdAt = Date.parse(tweet.created_at);
  const author = tweet.user;
  const authorCreatedAt = Date.parse(author.created_at);
  if (!Number.isFinite(createdAt) || !Number.isFinite(authorCreatedAt)) return null;

  return {
    id: tweet.tweet_id,
    text: tweet.full_text ?? tweet.text ?? '',
    urls: tweet.urls ?? [],
    views: tweet.view_count ?? 0,
    likes: tweet.favorite_count ?? 0,
    retweets: tweet.retweet_count ?? 0,
    createdAt,
    author: {
      screenName: author.screen_name,
      // 上游 friends_count 经常是 null，真正有值的是 following_count。
      followers: author.followers_count ?? 0,
      friends: author.friends_count ?? author.following_count ?? 0,
      statuses: author.statuses_count ?? 0,
      description: author.description ?? '',
      createdAt: authorCreatedAt,
      verified: Boolean(author.is_blue_verified ?? false) || Boolean(author.is_verified ?? false),
    },
  };
}

export interface SearchResult {
  readonly posts: readonly SocialPost[];
  readonly costUsd: number;
  readonly skipped: number;
}

export class XapiTwitterClient {
  readonly #apiKey: string;
  readonly #timeoutMs: number;

  constructor(options: { apiKey: string; timeoutMs?: number }) {
    if (!options.apiKey) throw new XapiError('NO_KEY', '缺少 xapi 凭据');
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async searchMentions(
    query: string,
    options: { sortBy?: 'Latest' | 'Top'; signal?: AbortSignal } = {},
  ): Promise<SearchResult> {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'xapi-key': this.#apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ searchTerms: [query], sortBy: options.sortBy ?? 'Latest' }),
      signal: options.signal ?? AbortSignal.timeout(this.#timeoutMs),
    });

    // 不回显上游正文：它可能很长，也可能夹带凭据或内部地址。
    if (!response.ok) throw new XapiError('UPSTREAM_FAILED', `上游返回 ${response.status}`);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new XapiError('BAD_SHAPE', '响应不是合法 JSON');
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw new XapiError('BAD_SHAPE', '响应结构不符合预期');

    const posts: SocialPost[] = [];
    let skipped = 0;
    for (const item of parsed.data.data) {
      const post = toPost(item);
      if (post) posts.push(post); else skipped += 1;
    }

    const cost = Number(response.headers.get('x-xapi-cost'));
    return { posts, skipped, costUsd: Number.isFinite(cost) ? cost : 0 };
  }
}
