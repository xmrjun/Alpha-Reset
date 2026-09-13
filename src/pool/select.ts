import { canonicalCa } from '../addresses.js';
import { resolveGeckoNetwork } from '../api/networks.js';
import type { StrategyConfig } from '../config/strategy.js';
import type { BoardPoolItem } from '../types.js';

export interface SelectedPoolItem extends BoardPoolItem { totalMentions: number }

export class PoolSelectionError extends Error {
  constructor(readonly code: 'POOL_RANK_MISSING' | 'POOL_CHAIN_CONFLICT' = 'POOL_RANK_MISSING') {
    super(code === 'POOL_CHAIN_CONFLICT' ? '同一 CA 出现不同网络，不能合并成一个观察成员'
      : '观察池缺少有效 total_mentions，不能可靠选取 Top N');
  }
}

export function selectObservationPool(groups: { groupName: string; items: BoardPoolItem[] }[], cfg: StrategyConfig) {
  const merged = new Map<string, BoardPoolItem>();
  for (const group of groups) {
    for (const item of group.items) {
      const ca = canonicalCa(item.ca);
      const previous = merged.get(ca);
      if (previous?.chain && item.chain && resolveGeckoNetwork(previous.chain) !== resolveGeckoNetwork(item.chain)) {
        throw new PoolSelectionError('POOL_CHAIN_CONFLICT');
      }
      const names = new Set([...(previous?.groupName?.split('、') ?? []), group.groupName]);
      const totalMentions = item.totalMentions === null ? previous?.totalMentions ?? null
        : Math.max(item.totalMentions, previous?.totalMentions ?? 0);
      const newest = !previous || (item.latestMentionTime ?? -1) > (previous.latestMentionTime ?? -1) ? item : previous;
      merged.set(ca, { ...newest, ca, chain: newest.chain ?? previous?.chain ?? item.chain,
        groupName: [...names].join('、'), totalMentions });
    }
  }
  const items: SelectedPoolItem[] = [];
  for (const item of merged.values()) {
    if (item.totalMentions === null || !Number.isSafeInteger(item.totalMentions) || item.totalMentions < 0) throw new PoolSelectionError();
    items.push({ ...item, totalMentions: item.totalMentions });
  }
  items.sort((a, b) => b.totalMentions - a.totalMentions || a.ca.localeCompare(b.ca));
  return { items: cfg.pool.maxCandidates === null ? items : items.slice(0, cfg.pool.maxCandidates), sourceCount: items.length,
    sourceLimited: groups.some((group) => group.items.length >= cfg.pool.perGroupLimit) };
}
