import type { StrategyConfig } from '../config/strategy.js';
import { INTERVAL_MS } from '../market.js';
import { BOARD_LIMITS } from '../api/erwa.js';
import { createPoolStore } from '../store/pool.js';
import { createRuntimeStore } from '../store/runtime.js';
import type { StoreDatabase } from '../store/db.js';
import type { AlertFilter, AlertRow } from '../store/alerts.js';
import type { AlertGroup, AlertsResponse } from './contracts.js';

export function dataQuality(db: StoreDatabase, cfg: StrategyConfig, now: number) {
  const pool = createPoolStore(db).getPool().filter((row) => row.groupName?.split('、').some((g) => cfg.observeGroups.includes(g)));
  const mayBeTruncated = cfg.observeGroups.some((group) => pool.filter((row) => row.groupName?.split('、').includes(group))
    .length >= BOARD_LIMITS.maxItems);
  const latest = db.prepare("SELECT 1 FROM candles WHERE ca = ? AND interval = '15m' AND open_time = ?");
  const expected = Math.floor(now / INTERVAL_MS['15m']) * INTERVAL_MS['15m'] - INTERVAL_MS['15m'];
  const freshPriceCount = pool.filter((row) => latest.get(row.ca, expected)).length;
  // RPS 是否可信以调度器落在快照里的 coverage 为准：那里已按 a4_rps.minCoverage 判过。
  // 此处不可再用"全池价格都新鲜"这种旧标准重判 —— 上游约 55% 的 CA 无 K 线，
  // 那个条件永远不成立，会把调度器算好的分值（如 r96 的 99% 覆盖）又清空。
  const round = createRuntimeStore(db).getRound();
  const coverage = round?.coverage;
  const rpsAvailable = Boolean(coverage && Object.values(coverage).some((item) => item.complete));
  return { mayBeTruncated, freshPriceCount, rpsAvailable, rpsCoverage: coverage ?? null };
}

export function queryAlertGroups(db: StoreDatabase, filter: AlertFilter = {}): AlertsResponse {
  const params = { ca: filter.ca ?? null, tag: filter.tag ?? null, from: filter.from ?? null,
    to: filter.to ?? null, limit: filter.limit ?? 200 };
  const groups = `SELECT ca, fired_at FROM alerts
    WHERE (@ca IS NULL OR ca = @ca) AND (@from IS NULL OR fired_at >= @from) AND (@to IS NULL OR fired_at <= @to)
    GROUP BY ca, fired_at HAVING @tag IS NULL OR SUM(CASE WHEN tag = @tag THEN 1 ELSE 0 END) > 0`;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${groups})`).get(params) as { n: number }).n;
  const rows = db.prepare(`WITH selected AS (${groups} ORDER BY fired_at DESC, MAX(id) DESC LIMIT @limit)
    SELECT a.id, a.ca, a.tag, a.fired_at AS firedAt, a.payload, a.pushed
    FROM alerts a JOIN selected s ON s.ca = a.ca AND s.fired_at = a.fired_at ORDER BY a.fired_at DESC, a.id DESC`)
    .all(params) as (Omit<AlertRow, 'pushed' | 'payload'> & { pushed: number; payload: string })[];
  const map = new Map<string, AlertGroup>();
  const pushedTags = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = JSON.stringify([row.ca, row.firedAt]);
    let group = map.get(key);
    if (!group) {
      group = { id: row.id, ca: row.ca, firedAt: row.firedAt, tags: [], payload: JSON.parse(row.payload) as unknown, pushed: false };
      map.set(key, group);
      pushedTags.set(key, new Set());
    }
    if (!group.tags.includes(row.tag)) group.tags.push(row.tag);
    if (row.pushed === 1) pushedTags.get(key)!.add(row.tag);
  }
  for (const [key, group] of map) group.pushed = group.tags.every((tag) => pushedTags.get(key)!.has(tag));
  return { items: [...map.values()], total };
}
