import type { StrategyConfig } from '../config/strategy.js';
import { INTERVAL_MS } from '../market.js';
import { BOARD_LIMITS } from '../api/erwa.js';
import { createPoolStore } from '../store/pool.js';
import { createRuntimeStore } from '../store/runtime.js';
import type { StoreDatabase } from '../store/db.js';
import type { AlertFilter, AlertRow } from '../store/alerts.js';
import type { AlertGroup, AlertsResponse } from './contracts.js';

export function dataQuality(db: StoreDatabase, cfg: StrategyConfig, now: number) {
  const round = createRuntimeStore(db).getRound();
  const coverage = round?.coverage;
  const members = round?.members ?? [];

  // 分母必须是「本轮实际监控的池子」，不是 ca_pool 的历史累计。
  // 历史累计只增不减（现已 500+），拿它当分母会让新鲜度看起来永远很差。
  const monitored = members.length;
  const latest = db.prepare("SELECT 1 FROM candles WHERE ca = ? AND interval = '15m' AND open_time = ?");
  const expected = Math.floor(now / INTERVAL_MS['15m']) * INTERVAL_MS['15m'] - INTERVAL_MS['15m'];
  const freshPriceCount = members.filter((member) => latest.get(member.pool.ca, expected)).length;

  // board/summary 每群硬上限 200，触顶说明该群「近期提及」被截断。
  // 这不代表历史缺失 —— 历史全集来自 group_ca_history（npm run backfill）。
  const mayBeTruncated = round?.sourceLimited ?? false;

  // RPS 是否可用，以调度器写入快照的 coverage 为准（那里已按 a4_rps.minCoverage 判过）。
  // 不可在此用「全池价格都新鲜」之类的旧标准重判 —— 那个标准永远不成立，
  // 正是它当初导致 A4 恒假、系统永不告警。
  const ready = coverage
    ? Object.entries(coverage).filter(([, item]) => item.complete).map(([key]) => key)
    : [];

  return {
    mayBeTruncated,
    freshPriceCount,
    monitored,
    observeGroups: cfg.observeGroups.length,
    rpsAvailable: ready.length > 0,
    rpsReadyKeys: ready,
    roundStatus: round?.status ?? null,
    roundRunning: round?.status === 'running',
    rpsCoverage: coverage ?? null,
  };
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
