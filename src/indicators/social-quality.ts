/**
 * 社交面质量判定：从一批提及某个代币的推文里，分出"有人真在讨论"和"有人在买刷量"。
 *
 * 为什么不直接看提及数：实测一个刚起量的 Solana 代币，24 小时 20 条提及里 15 条是
 * 同一套文案换 emoji、轮换 netlify.app 落地页的批量投放。提及数越高反而越可能是
 * 有人在花钱做量，所以"热度"是反向指标，真正有用的是刷量占比。
 *
 * 纯函数：不读库、不发请求、不调 Date.now()。参考时间取这批推文里最新的一条。
 */

export interface SocialAuthor {
  readonly screenName: string;
  readonly followers: number;
  readonly friends: number;
  readonly statuses: number;
  readonly description: string;
  readonly createdAt: number;
  readonly verified: boolean;
}

export interface SocialPost {
  readonly id: string;
  readonly text: string;
  readonly urls: readonly string[];
  readonly views: number;
  readonly likes: number;
  readonly retweets: number;
  readonly createdAt: number;
  readonly author: SocialAuthor;
}

export type SocialFlag =
  | 'template'         // 与其它推文同属一个模板簇
  | 'throwaway_host'   // 落地页挂在免费托管或短链上
  | 'host_rotation'    // 同一个托管域名在这批结果里反复出现
  | 'zombie_account'   // 账号画像异常：关注极少却粉丝上千，或发帖密度离谱
  | 'low_reach';       // 浏览量极低，平台没有给真实分发

export interface PostVerdict {
  readonly id: string;
  readonly manufactured: boolean;
  readonly score: number;
  readonly flags: readonly SocialFlag[];
}

export interface SocialQuality {
  readonly total: number;
  readonly organic: number;
  readonly manufactured: number;
  readonly botRatio: number;
  readonly clusters: number;
  readonly medianViews: number;
  readonly kols: readonly string[];
  readonly mentions: readonly string[];
  readonly verdict: 'quiet' | 'organic' | 'mixed' | 'manufactured';
  readonly posts: readonly PostVerdict[];
}

/** 粉丝到这个量级才当"大V"看；低于这个数的账号在 meme 币语境里遍地都是。 */
export const KOL_MIN_FOLLOWERS = 50_000;

const SCORE_THRESHOLD = 3;
const LOW_REACH_VIEWS = 200;
const SIMILARITY = 0.45;
const MIN_TOKENS = 4;          // 太短的文本不参与聚类，否则只剩 $TICKER 会两两 100% 相似
const ROTATION_MIN = 3;
const DAY = 24 * 60 * 60 * 1000;

/** 只去最常见的功能词：去太多会把不同模板也抹成一样。 */
const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'be', 'to', 'of', 'in', 'on', 'at', 'it',
  'this', 'that', 'and', 'or', 'but', 'if', 'for', 'with', 'you', 'your', 'my', 'me', 'we', 'they',
  'what', 'about', 'out', 'up', 'so', 'not', 'no', 'do', 'can', 'will', 'from', 'by', 'as', 'i',
  'has', 'have', 'its', 'their', 'more', 'just', 'now', 'here', 'there', 'am', 'pm']);

const THROWAWAY_HOSTS = new Set(['netlify.app', 'vercel.app', 'pages.dev', 'web.app', 'github.io',
  'firebaseapp.com', 'glitch.me', 'repl.co', 'surge.sh', 'onrender.com', 'rb.gy', 'bit.ly',
  'tinyurl.com', 'cutt.ly', 'shorturl.at', 'is.gd', 'ow.ly']);

/** 取域名的最后两段当归属；.co.uk 这类会不准，但这里只用来数"同一家托管"。 */
function registrable(url: string): string | null {
  try {
    const parts = new URL(url).hostname.toLowerCase().split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 规范化成词集合：去 URL、去合约地址、去 emoji 与标点、去纯数字、粗暴去复数。
 * 去数字很关键——模板里那个递增的 Listing ID 否则会把同一套文案拆成不同簇。
 */
function tokenize(text: string): Set<string> {
  const cleaned = text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[a-zA-Z0-9]{32,}\b/g, ' ')   // 合约地址
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase();
  const out = new Set<string>();
  for (const raw of cleaned.split(/\s+/)) {
    if (!raw || /^\d+$/.test(raw)) continue;
    const word = raw.length > 3 && raw.endsWith('s') ? raw.slice(0, -1) : raw;
    if (word.length < 2 || STOP.has(word)) continue;
    out.add(word);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** 并查集：文本相似或共用落地页域名的推文并进同一个模板簇。 */
function cluster(posts: readonly SocialPost[]): number[] {
  const parent = posts.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    return root;
  };
  const union = (a: number, b: number): void => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[rb] = ra;
  };

  const words = posts.map((p) => tokenize(p.text));
  const hosts = posts.map((p) => new Set(p.urls.map(hostOf).filter((h): h is string => h !== null)));

  for (let i = 0; i < posts.length; i += 1) {
    for (let j = i + 1; j < posts.length; j += 1) {
      const sharedHost = [...hosts[i]!].some((h) => hosts[j]!.has(h));
      const wi = words[i]!;
      const wj = words[j]!;
      const similar = wi.size >= MIN_TOKENS && wj.size >= MIN_TOKENS && jaccard(wi, wj) >= SIMILARITY;
      if (sharedHost || similar) union(i, j);
    }
  }
  return posts.map((_, i) => find(i));
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function collectMentions(posts: readonly SocialPost[]): string[] {
  const found = new Set<string>();
  for (const post of posts) {
    for (const match of post.text.matchAll(/@([A-Za-z0-9_]{2,15})\b/g)) found.add(match[1]!);
  }
  return [...found].sort();
}

export function assessSocial(posts: readonly SocialPost[]): SocialQuality {
  if (posts.length === 0) {
    return { total: 0, organic: 0, manufactured: 0, botRatio: 0, clusters: 0, medianViews: 0,
      kols: [], mentions: [], verdict: 'quiet', posts: [] };
  }

  const reference = Math.max(...posts.map((p) => p.createdAt));
  const roots = cluster(posts);
  const clusterSize = new Map<number, number>();
  for (const root of roots) clusterSize.set(root, (clusterSize.get(root) ?? 0) + 1);

  const domainCount = new Map<string, number>();
  for (const post of posts) {
    for (const domain of new Set(post.urls.map(registrable).filter((d): d is string => d !== null))) {
      domainCount.set(domain, (domainCount.get(domain) ?? 0) + 1);
    }
  }

  const verdicts: PostVerdict[] = posts.map((post, index) => {
    const flags: SocialFlag[] = [];
    let score = 0;

    if ((clusterSize.get(roots[index]!) ?? 1) > 1) { flags.push('template'); score += 2; }

    const domains = new Set(post.urls.map(registrable).filter((d): d is string => d !== null));
    if ([...domains].some((d) => THROWAWAY_HOSTS.has(d))) { flags.push('throwaway_host'); score += 1; }
    if ([...domains].some((d) => (domainCount.get(d) ?? 0) >= ROTATION_MIN)) {
      flags.push('host_rotation'); score += 1;
    }

    const ageDays = Math.max(1, (reference - post.author.createdAt) / DAY);
    const perDay = post.author.statuses / ageDays;
    const lopsided = post.author.friends < 50 && post.author.followers > 1000;
    if (lopsided || perDay > 20) { flags.push('zombie_account'); score += 2; }

    if (post.views < LOW_REACH_VIEWS) { flags.push('low_reach'); score += 1; }

    return { id: post.id, score, flags, manufactured: score >= SCORE_THRESHOLD };
  });

  const manufactured = verdicts.filter((v) => v.manufactured).length;
  const botRatio = manufactured / posts.length;
  const realClusters = [...clusterSize.values()].filter((size) => size > 1).length;

  const kols = [...new Set(posts
    .filter((post, index) => post.author.followers >= KOL_MIN_FOLLOWERS && !verdicts[index]!.manufactured)
    .map((post) => post.author.screenName))].sort();

  const verdict = botRatio >= 0.6 ? 'manufactured' : botRatio >= 0.25 ? 'mixed' : 'organic';

  return {
    total: posts.length,
    organic: posts.length - manufactured,
    manufactured,
    botRatio,
    clusters: realClusters,
    medianViews: median(posts.map((p) => p.views)),
    kols,
    mentions: collectMentions(posts),
    verdict,
    posts: verdicts,
  };
}
