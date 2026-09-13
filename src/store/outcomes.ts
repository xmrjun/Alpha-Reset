import type { StoreDatabase } from './db.js';

export interface CohortEntry {
  ca: string;
  baselineAt: number;
  horizonHours: number;
  alerted: boolean;
  tags: string[];
  /** 两个端点必须取自同一条序列；legacy 回填无序列时为 null。 */
  seriesId: string | null;
  entryPrice: number;
}
export interface PendingOutcome {
  ca: string; baselineAt: number; horizonHours: number; seriesId: string | null; entryPrice: number;
}
export interface OutcomeStat {
  horizonHours: number;
  alerted: { n: number; median: number | null; winRate: number | null };
  control: { n: number; median: number | null; winRate: number | null };
}
export interface TagStat { tag: string; horizonHours: number; n: number; median: number | null; winRate: number | null }

/** 纯函数：收益口径集中在这里，便于测试与复核。 */
export function returnPct(entry: number, exit: number): number | null {
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0 || exit <= 0) return null;
  const value = (exit / entry - 1) * 100;
  return Number.isFinite(value) ? value : null;
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const winRate = (values: number[]): number | null =>
  values.length ? values.filter((value) => value > 0).length / values.length * 100 : null;

export function createOutcomeStore(db: StoreDatabase) {
  const insert = db.prepare(`INSERT INTO alert_outcomes
    (ca, baseline_at, horizon_hours, alerted, tags, series_id, entry_price, recorded_at)
    VALUES (@ca, @baselineAt, @horizonHours, @alerted, @tags, @seriesId, @entryPrice, @recordedAt)
    ON CONFLICT(ca, baseline_at, horizon_hours) DO UPDATE SET
      alerted = MAX(alert_outcomes.alerted, excluded.alerted),
      tags = CASE WHEN excluded.tags <> '' THEN excluded.tags ELSE alert_outcomes.tags END
    WHERE alert_outcomes.return_pct IS NULL`);
  // settled_at 表示"已尝试结算"，return_pct 表示"确实得到了收益"。
  // 到期取不到同源退出价的行只有前者，必须一并排除，否则会被无限重复扫描。
  const selectPending = db.prepare(`SELECT ca, baseline_at AS baselineAt, horizon_hours AS horizonHours,
    series_id AS seriesId, entry_price AS entryPrice FROM alert_outcomes
    WHERE return_pct IS NULL AND settled_at IS NULL AND baseline_at + horizon_hours * 3600000 <= ?
    ORDER BY baseline_at LIMIT ?`);
  const settleRow = db.prepare(`UPDATE alert_outcomes
    SET exit_price = @exitPrice, return_pct = @returnPct, settled_at = @settledAt
    WHERE ca = @ca AND baseline_at = @baselineAt AND horizon_hours = @horizonHours AND return_pct IS NULL`);
  const abandonRow = db.prepare(`UPDATE alert_outcomes SET settled_at = @settledAt
    WHERE ca = @ca AND baseline_at = @baselineAt AND horizon_hours = @horizonHours AND return_pct IS NULL`);
  const selectStats = db.prepare(`SELECT horizon_hours AS horizonHours, alerted, return_pct AS returnPct
    FROM alert_outcomes WHERE return_pct IS NOT NULL AND baseline_at >= ?`);
  const selectTagRows = db.prepare(`SELECT horizon_hours AS horizonHours, tags, return_pct AS returnPct
    FROM alert_outcomes WHERE return_pct IS NOT NULL AND alerted = 1 AND baseline_at >= ?`);

  return {
    /** 同一 T 重复登记不覆盖已结算行；后到的标签补齐，alerted 只升不降。 */
    recordCohort: db.transaction((entries: CohortEntry[], recordedAt: number): number => {
      let written = 0;
      for (const entry of entries) {
        if (!Number.isFinite(entry.entryPrice) || entry.entryPrice <= 0) continue;
        written += insert.run({
          ca: entry.ca, baselineAt: entry.baselineAt, horizonHours: entry.horizonHours,
          alerted: entry.alerted ? 1 : 0, tags: [...new Set(entry.tags)].sort().join(','),
          seriesId: entry.seriesId, entryPrice: entry.entryPrice, recordedAt,
        }).changes;
      }
      return written;
    }),
    pending(now: number, limit = 500): PendingOutcome[] {
      return selectPending.all(now, limit) as PendingOutcome[];
    },
    /** 收益为空表示到期仍取不到同源退出价；记 settled_at 停止重复扫描，但不写入收益。 */
    settle: db.transaction((row: PendingOutcome, exitPrice: number | null, settledAt: number): boolean => {
      const value = exitPrice === null ? null : returnPct(row.entryPrice, exitPrice);
      const key = { ca: row.ca, baselineAt: row.baselineAt, horizonHours: row.horizonHours };
      if (value === null) { abandonRow.run({ ...key, settledAt }); return false; }
      return settleRow.run({ ...key, exitPrice, returnPct: value, settledAt }).changes > 0;
    }),
    /** since 之前的数据不参与统计，便于按时间窗口比较不同版本的策略表现。 */
    stats(since = 0): OutcomeStat[] {
      const rows = selectStats.all(since) as { horizonHours: number; alerted: number; returnPct: number }[];
      const byHorizon = new Map<number, { a: number[]; c: number[] }>();
      for (const row of rows) {
        const bucket = byHorizon.get(row.horizonHours) ?? { a: [], c: [] };
        (row.alerted ? bucket.a : bucket.c).push(row.returnPct);
        byHorizon.set(row.horizonHours, bucket);
      }
      return [...byHorizon.entries()].sort((a, b) => a[0] - b[0]).map(([horizonHours, bucket]) => ({
        horizonHours,
        alerted: { n: bucket.a.length, median: median(bucket.a), winRate: winRate(bucket.a) },
        control: { n: bucket.c.length, median: median(bucket.c), winRate: winRate(bucket.c) },
      }));
    },
    /** 一条告警可带多个标签，逐标签计入；同一事件会在多个标签下重复出现。 */
    tagStats(since = 0): TagStat[] {
      const rows = selectTagRows.all(since) as { horizonHours: number; tags: string; returnPct: number }[];
      const byKey = new Map<string, { tag: string; horizonHours: number; values: number[] }>();
      for (const row of rows) {
        for (const tag of row.tags.split(',').filter(Boolean)) {
          const key = `${tag}|${row.horizonHours}`;
          const bucket = byKey.get(key) ?? { tag, horizonHours: row.horizonHours, values: [] };
          bucket.values.push(row.returnPct);
          byKey.set(key, bucket);
        }
      }
      return [...byKey.values()].map((bucket) => ({
        tag: bucket.tag, horizonHours: bucket.horizonHours, n: bucket.values.length,
        median: median(bucket.values), winRate: winRate(bucket.values),
      })).sort((a, b) => a.horizonHours - b.horizonHours || (b.median ?? -Infinity) - (a.median ?? -Infinity));
    },
  };
}
