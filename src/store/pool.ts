import type { PoolItem } from '../types.js';
import type { StoreDatabase } from './db.js';

export interface PoolSnapshotItem extends PoolItem {
  tokenName?: string | null;
  listedAt?: number | null;
}

export interface PoolRow extends PoolItem {
  tokenName: string | null;
  firstSeenAt: number;
  listedAt: number | null;
  updatedAt: number;
}

const columns = `ca, symbol, chain, token_name AS tokenName, market_cap AS marketCap,
  liquidity, volume_24h AS volume24h, group_name AS groupName,
  first_seen_at AS firstSeenAt, listed_at AS listedAt,
  latest_mention_time AS latestMentionTime, updated_at AS updatedAt`;

export function createPoolStore(db: StoreDatabase) {
  const upsert = db.prepare(`
    INSERT INTO ca_pool (ca, symbol, chain, token_name, market_cap, liquidity, volume_24h,
      group_name, first_seen_at, listed_at, latest_mention_time, updated_at)
    VALUES (@ca, @symbol, @chain, @tokenName, @marketCap, @liquidity, @volume24h,
      @groupName, @now, @listedAt, @latestMentionTime, @now)
    ON CONFLICT (ca) DO UPDATE SET
      symbol = excluded.symbol, chain = excluded.chain,
      token_name = COALESCE(excluded.token_name, ca_pool.token_name),
      market_cap = excluded.market_cap, liquidity = excluded.liquidity,
      volume_24h = excluded.volume_24h, group_name = excluded.group_name,
      listed_at = COALESCE(excluded.listed_at, ca_pool.listed_at),
      latest_mention_time = excluded.latest_mention_time, updated_at = excluded.updated_at
    WHERE excluded.updated_at >= ca_pool.updated_at
  `);
  const select = db.prepare(`SELECT ${columns} FROM ca_pool WHERE ca = ?`);
  const list = db.prepare(`SELECT ${columns} FROM ca_pool ORDER BY updated_at DESC, ca`);
  const listing = db.prepare('UPDATE ca_pool SET listed_at = ? WHERE ca = ?');

  return {
    upsertPool: db.transaction((items: PoolSnapshotItem[], now: number): void => {
      for (const item of items) {
        upsert.run({ ...item, tokenName: item.tokenName ?? null, listedAt: item.listedAt ?? null, now });
      }
    }),
    getPoolItem(ca: string): PoolRow | null {
      return (select.get(ca) as PoolRow | undefined) ?? null;
    },
    getPool(): PoolRow[] {
      return list.all() as PoolRow[];
    },
    setListedAt(ca: string, listedAt: number | null): void { listing.run(listedAt, ca); },
  };
}
