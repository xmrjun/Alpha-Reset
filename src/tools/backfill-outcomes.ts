/**
 * 把历史告警回填进 alert_outcomes。
 *
 * 只能回填告警组：历史轮次的 qualified 成员集合没有持久化，重建不出来，
 * 所以对照组从本工具运行之后由调度器逐轮累积。统计时两组的 n 分开显示，
 * 对照组为空是可见的，不会被误读成"告警组跑赢"。
 *
 * 入场价与退出价必须取自同一来源：优先该 CA 的 series，回退到 v4 之前的
 * legacy candles 表，但绝不在一笔收益内跨表取端点。
 */
import { loadStrategy } from '../config/strategy.js';
import { INTERVAL_MS } from '../market.js';
import { openDatabase } from '../store/db.js';
import { createOutcomeStore, type CohortEntry } from '../store/outcomes.js';

const HOUR_MS = 3_600_000;
const TOLERANCE_BARS = 8;

async function main(): Promise<void> {
  const cfg = loadStrategy();
  const { config } = await import('../config.js');
  const db = openDatabase(config.databasePath);
  const outcomes = createOutcomeStore(db);
  const now = Date.now();

  const seriesOf = db.prepare('SELECT id FROM market_series WHERE ca = ?');
  const seriesClose = db.prepare(`SELECT close FROM series_candles
    WHERE series_id = ? AND interval = '15m' AND open_time = ?`);
  const legacyClose = db.prepare(`SELECT close FROM candles
    WHERE ca = ? AND interval = '15m' AND open_time = ?`);
  const events = db.prepare(`SELECT ca, fired_at AS firedAt, group_concat(DISTINCT tag) AS tags
    FROM alerts GROUP BY ca, fired_at ORDER BY fired_at`).all() as
    { ca: string; firedAt: number; tags: string }[];

  const price = (get: (openTime: number) => unknown, closeTime: number): number | null => {
    // 旧告警的触发时刻不在 15m 网格上，先对齐再按容差回看。
    const grid = Math.floor(closeTime / INTERVAL_MS['15m']) * INTERVAL_MS['15m'];
    for (let back = 0; back < TOLERANCE_BARS; back++) {
      const row = get(grid - INTERVAL_MS['15m'] - back * INTERVAL_MS['15m']) as { close: number } | undefined;
      if (row && Number.isFinite(row.close) && row.close > 0) return row.close;
    }
    return null;
  };

  let recorded = 0, settled = 0, skipped = 0;
  for (const event of events) {
    const baselineAt = Math.floor(event.firedAt / INTERVAL_MS['15m']) * INTERVAL_MS['15m'];
    const tags = event.tags.split(',').filter(Boolean);
    const seriesIds = (seriesOf.all(event.ca) as { id: string }[]).map((row) => row.id);
    for (const hours of cfg.outcomes.horizonsHours) {
      if (baselineAt + hours * HOUR_MS > now) continue;
      // 同源约束：先在每条 series 内部找齐两端，都不行才整体回退 legacy。
      let entryPrice: number | null = null, exitPrice: number | null = null, seriesId: string | null = null;
      for (const id of seriesIds) {
        const a = price((t) => seriesClose.get(id, t), baselineAt);
        const b = price((t) => seriesClose.get(id, t), baselineAt + hours * HOUR_MS);
        if (a !== null && b !== null) { entryPrice = a; exitPrice = b; seriesId = id; break; }
      }
      if (entryPrice === null) {
        const a = price((t) => legacyClose.get(event.ca, t), baselineAt);
        const b = price((t) => legacyClose.get(event.ca, t), baselineAt + hours * HOUR_MS);
        if (a !== null && b !== null) { entryPrice = a; exitPrice = b; seriesId = null; }
      }
      if (entryPrice === null || exitPrice === null) { skipped++; continue; }
      const entry: CohortEntry = { ca: event.ca, baselineAt, horizonHours: hours,
        alerted: true, tags, seriesId, entryPrice };
      recorded += outcomes.recordCohort([entry], now);
      const pending = outcomes.pending(now).find((row) =>
        row.ca === entry.ca && row.baselineAt === entry.baselineAt && row.horizonHours === hours);
      if (pending && outcomes.settle(pending, exitPrice, now)) settled++;
    }
  }
  console.log(JSON.stringify({ event: 'outcomes_backfilled', events: events.length, recorded, settled, skipped }));
  for (const stat of outcomes.stats()) {
    console.log(`  ${stat.horizonHours}h  告警组 n=${stat.alerted.n} 中位=${stat.alerted.median?.toFixed(1) ?? '—'} 胜率=${stat.alerted.winRate?.toFixed(0) ?? '—'}%`
      + `  对照组 n=${stat.control.n}`);
  }
  db.close();
}

await main();
