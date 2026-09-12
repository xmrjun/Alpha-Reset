import { canonicalCa } from '../addresses.js';

/**
 * 三个观察组的历史 CA 回填。
 *
 * 为什么只能全量拉再过滤：`/api/v1/group_ca/sync` **不支持 group_name 筛选**
 * （实测带与不带该参数返回完全一致），`/api/v1/group_ca` 的 group_name 参数同样失效。
 * `board/summary` 虽可按群筛，但 limit 硬上限 200，拿不到完整历史。
 *
 * 因此：全量翻页，但**只保留观察组的记录**（实测三群仅占全量的约 2%）。
 * 上游最早数据为 2026-04-11（id=1），至 2026-09-11 约 5 个月。
 */
export const PAGE_LIMIT = 500; // sync 的 limit 上限

export interface SyncItem {
  id: number;
  ca: string | null;
  group_name: string | null;
  create_time: string | null;
  symbol?: string | null;
  chain?: string | null;
}

export interface BackfillResult {
  scanned: number;
  kept: number;
  lastAfterId: number;
  earliest: string | null;
  items: SyncItem[];
}

export async function backfill(opts: {
  baseUrl: string;
  token: string;
  groups: string[];
  startAfterId?: number;
  maxPages?: number;
  onProgress?: (info: { afterId: number; scanned: number; kept: number }) => void;
  fetchImpl?: typeof fetch;
}): Promise<BackfillResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const wanted = new Set(opts.groups);
  const seen = new Map<string, SyncItem>();
  let afterId = opts.startAfterId ?? 0;
  let scanned = 0;
  let earliest: string | null = null;

  for (let page = 0; page < (opts.maxPages ?? Number.MAX_SAFE_INTEGER); page++) {
    const url = new URL('/api/v1/group_ca/sync', opts.baseUrl);
    url.searchParams.set('after_id', String(afterId));
    url.searchParams.set('limit', String(PAGE_LIMIT));
    const response = await doFetch(url, {
      headers: { Authorization: `Bearer ${opts.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`历史同步失败（${response.status}）`);
    const body = await response.json() as { items?: SyncItem[]; next_after_id?: number; has_more?: boolean };
    const items = body.items ?? [];
    if (items.length === 0) break;

    for (const item of items) {
      scanned++;
      if (earliest === null && item.create_time) earliest = item.create_time;
      if (!item.ca || !item.group_name || !wanted.has(item.group_name)) continue;
      const key = canonicalCa(item.ca);
      // 同一 CA 多次提及只保留最早一条，用于推断首次进入观察组的时间。
      // 注意存的是 canonical 形式：上游同一个 EVM 地址会以不同大小写出现，
      // 若按原样入库，同一个币会变成多行，与其他表也对不上。
      if (!seen.has(key)) seen.set(key, { ...item, ca: key });
    }
    afterId = body.next_after_id ?? items[items.length - 1]!.id;
    opts.onProgress?.({ afterId, scanned, kept: seen.size });
    if (body.has_more === false) break;
  }
  return { scanned, kept: seen.size, lastAfterId: afterId, earliest, items: [...seen.values()] };
}
