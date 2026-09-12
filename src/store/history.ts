import type { StoreDatabase } from './db.js';

export interface HistoryRow {
  ca: string;
  symbol: string | null;
  chain: string | null;
  groupName: string | null;
  firstMentionId: number;
  firstMentionAt: number;
}

/**
 * 观察组历史 CA 全集。
 *
 * 存在的理由：`board/summary` 按群只返回 top 200（API 硬上限），拿不到完整历史。
 * 而 `group_ca/sync` 虽能翻全量，却**不支持按群筛选**，只能拉全量再本地过滤
 * （目标三群仅占全站约 1.3%）。因此把过滤结果落到本表，避免反复全量扫描。
 */
export function createHistoryStore(db: StoreDatabase) {
  const upsert = db.prepare(`INSERT INTO group_ca_history
    (ca, symbol, chain, group_name, first_mention_id, first_mention_at, synced_at)
    VALUES (@ca, @symbol, @chain, @groupName, @firstMentionId, @firstMentionAt, @syncedAt)
    ON CONFLICT(ca) DO UPDATE SET
      symbol = COALESCE(excluded.symbol, symbol),
      chain = COALESCE(excluded.chain, chain),
      -- 同一 CA 可能被多个群提过：保留最早的那次，用于推断首次进入观察组的时间
      group_name = CASE WHEN excluded.first_mention_id < first_mention_id
        THEN excluded.group_name ELSE group_name END,
      first_mention_id = MIN(first_mention_id, excluded.first_mention_id),
      first_mention_at = MIN(first_mention_at, excluded.first_mention_at),
      synced_at = excluded.synced_at`);

  return {
    /** 幂等写入；重复回填不会产生重复行，也不会把更早的记录覆盖成较晚的 */
    save(rows: HistoryRow[], syncedAt: number): number {
      if (rows.length === 0) return 0;
      const run = db.transaction((batch: HistoryRow[]) => {
        for (const row of batch) upsert.run({ ...row, syncedAt });
      });
      run(rows);
      return rows.length;
    },
    count(): number {
      return (db.prepare('SELECT COUNT(*) AS n FROM group_ca_history').get() as { n: number }).n;
    },
    /** 按最早提及时间倒序，供扩池使用 */
    recent(limit: number): HistoryRow[] {
      return db.prepare(`SELECT ca, symbol, chain, group_name AS groupName,
        first_mention_id AS firstMentionId, first_mention_at AS firstMentionAt
        FROM group_ca_history ORDER BY first_mention_at DESC LIMIT ?`).all(limit) as HistoryRow[];
    },
    byGroup(): { groupName: string | null; n: number }[] {
      return db.prepare(`SELECT group_name AS groupName, COUNT(*) AS n
        FROM group_ca_history GROUP BY group_name ORDER BY n DESC`).all() as { groupName: string | null; n: number }[];
    },
  };
}
