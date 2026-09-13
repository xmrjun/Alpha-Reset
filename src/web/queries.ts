import { z } from 'zod';
import { createWebReadModel, type WebReadContext } from './read-context.js';
import type { StrategyConfig } from '../config/strategy.js';
import { resolveGmgnChain } from '../api/gmgn.js';
import { INTERVAL_MS } from '../market.js';
import { latestObservationRound, readRpsDisplay, verifiedCalculationSeries, verifiedDisplaySeries } from './rps-display.js';
import { isRoundFresh, strategyKey } from '../store/runtime.js';
import type { StoreDatabase } from '../store/db.js';
import type { AlertFilter, AlertRow } from '../store/alerts.js';
import type { AlertGroup, AlertsResponse, OutcomesResponse } from './contracts.js';
import { createOutcomeStore } from '../store/outcomes.js';

// 只发布白名单字段；运行状态中的内部错误、地址和凭据不会出现在 Web 快照。
const gmgnStatusSchema = z.object({
  status: z.enum(['running', 'idle', 'cooldown', 'auth_error', 'disabled']),
  updatedAt: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(), recentRequests: z.number().int().nonnegative(),
  historyRequests: z.number().int().nonnegative(), assetsWithHistory: z.number().int().nonnegative(),
  backfillPending: z.number().int().nonnegative(), cooldownUntil: z.number().nonnegative(),
});

export function dataQuality(db: StoreDatabase, cfg: StrategyConfig, now: number, suppliedContext?: WebReadContext) {
  const context = suppliedContext ?? createWebReadModel(db, cfg).readContext();
  const runtime = context.runtime;
  const stored = runtime.getRound();
  const calculation = stored?.strategyKey === strategyKey(cfg) ? stored : null;
  const collecting = runtime.getCollectionRound();
  const round = collecting?.strategyKey === strategyKey(cfg) ? collecting : calculation;
  const observation = latestObservationRound(db, cfg, context);
  const discoveryAttempt = runtime.getDiscoveryRound();
  const discovery = discoveryAttempt?.strategyKey === strategyKey(cfg) ? discoveryAttempt : null;
  const effectiveRpm = Math.min(cfg.kline.requestsPerMinute, 10);
  const coverage = calculation?.coverage;
  // collection_round 保存整池快照；当前已交给 GMGN 的资产不是 Gecko 请求队列。
  const members = (round?.members ?? []).filter((member) => {
    const active = verifiedDisplaySeries(db, member, context);
    if (active) return active.source !== 'gmgn';
    const chain = resolveGmgnChain(member.pool.chain ?? member.dex?.chainId ?? '');
    return !(cfg.kline.gmgn.enabled && chain && cfg.kline.gmgn.chains.includes(chain));
  });

  // 分母必须是「本轮实际监控的池子」，不是 ca_pool 的历史累计。
  // 历史累计只增不减（现已 500+），拿它当分母会让新鲜度看起来永远很差。
  const monitored = members.length;
  // 取价截止为本轮固定时间；采集跨过15m边界不应把已到位端点归零。
  const baselineAt = round ? Math.floor(round.startedAt / INTERVAL_MS['15m']) * INTERVAL_MS['15m'] : null;
  const expected = (baselineAt ?? Math.floor(now / INTERVAL_MS['15m']) * INTERVAL_MS['15m']) - INTERVAL_MS['15m'];
  const identities = members.map((member) => verifiedDisplaySeries(db, member, context));
  const freshPriceCount = members.filter((member, i) => (member.seriesId === undefined || identities[i])
    && context.hasEndpoint(member, expected)).length;
  const succeeded = members.filter((member) => member.klineStatus === 'ready').length;
  const failed = members.filter((member) => member.klineStatus === 'error').length;
  const display = readRpsDisplay(db, cfg, now, context);

  const sources = { gmgn: 0, geckoterminal: 0, unbound: 0 };
  for (const member of calculation?.members ?? []) {
    const identity = verifiedCalculationSeries(db, member, context);
    if (identity?.source === 'gmgn' || identity?.source === 'geckoterminal') sources[identity.source]++;
    else sources.unbound++;
  }
  let gmgnStatus: z.infer<typeof gmgnStatusSchema> | null = null;
  try {
    const row = db.prepare("SELECT payload FROM runtime_state WHERE key = 'gmgn_status'").get() as { payload: string } | undefined;
    const parsed = gmgnStatusSchema.safeParse(row ? JSON.parse(row.payload) : null);
    if (parsed.success) gmgnStatus = parsed.data;
  } catch { /* 状态缺失/损坏时等待采集器发布，不能回显原 payload。 */ }
  const gmgnEnabled = cfg.kline.gmgn?.enabled ?? false;
  const gmgn = { enabled: gmgnEnabled,
    status: gmgnEnabled ? gmgnStatus?.status ?? null : 'disabled' as const,
    updatedAt: gmgnStatus?.updatedAt ?? null, effectiveRpm: cfg.kline.gmgn?.requestsPerMinute ?? 0,
    requests: gmgnStatus?.requests ?? 0, recentRequests: gmgnStatus?.recentRequests ?? 0,
    historyRequests: gmgnStatus?.historyRequests ?? 0, assetsWithHistory: gmgnStatus?.assetsWithHistory ?? 0,
    backfillPending: gmgnStatus?.backfillPending ?? 0, cooldownUntil: gmgnStatus?.cooldownUntil ?? 0 };

  // board/summary 每群硬上限 200，触顶说明该群「近期提及」被截断。
  // 这不代表历史缺失 —— 历史全集来自 group_ca_history（npm run backfill）。
  const mayBeTruncated = observation?.sourceLimited ?? false;

  // RPS 是否可用，以调度器写入快照的 coverage 为准（那里已按 a4_rps.minCoverage 判过）。
  // 不可在此用「全池价格都新鲜」之类的旧标准重判 —— 那个标准永远不成立，
  // 正是它当初导致 A4 恒假、系统永不告警。
  const fresh = isRoundFresh(calculation, cfg, now);
  const ready = coverage && fresh
    ? Object.entries(coverage).filter(([, item]) => item.complete).map(([key]) => key) : [];
  const bounded = coverage && fresh
    ? Object.entries(coverage).filter(([, item]) => (item.boundedPassCount ?? 0) > 0).map(([key]) => key) : [];

  return {
    enabledSources: gmgnEnabled ? ['geckoterminal', 'gmgn'] as const : ['geckoterminal'] as const,
    gmgn,
    mayBeTruncated,
    freshPriceCount,
    monitored,
    observeGroups: cfg.observeGroups.length,
    rpsAvailable: ready.length > 0 || bounded.length > 0,
    rpsReadyKeys: ready,
    rpsBoundedKeys: bounded,
    roundStatus: calculation?.status ?? null,
    /** 当前 RPS 是否来自上一轮（本轮尚在计算） */
    rpsFromPreviousRound: display.summary?.state === 'previous',
    roundRunning: round?.status === 'running',
    rpsCoverage: coverage ?? null,
    rpsDisplay: display.summary,
    observation: { sourceCount: observation?.sourceCount ?? 0, memberCount: observation?.members.length ?? 0,
      updatedAt: observation ? observation.observedAt ?? observation.completedAt ?? observation.startedAt : null,
      refreshMinutes: cfg.pool.refreshMinutes, upstreamLimited: mayBeTruncated,
      ...(discovery ? { discoveryStatus: discovery.status, discoveryFailures: discovery.failures,
        lastAttemptAt: discovery.startedAt } : {}),
      ...(observation?.addedCount !== undefined ? { addedCount: observation.addedCount } : {}),
      ...(observation?.removedCount !== undefined ? { removedCount: observation.removedCount } : {}) },
    calculation: { memberCount: calculation?.members.length ?? 0,
      asOf: calculation ? Math.floor(calculation.startedAt / INTERVAL_MS['15m']) * INTERVAL_MS['15m'] : null,
      computedAt: calculation?.completedAt ?? null, sources },
    collection: { source: 'geckoterminal' as const, memberCount: monitored, effectiveRpm, minSweepMinutes: monitored / effectiveRpm, boardComplete: round?.boardComplete ?? false, baselineAt, processed: succeeded + failed,
      succeeded, failed, historyAvailable: identities.filter(Boolean).length },
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
    SELECT a.id, a.ca, a.tag, a.fired_at AS firedAt, a.payload, a.pushed,
           p.chain, p.symbol
    FROM alerts a JOIN selected s ON s.ca = a.ca AND s.fired_at = a.fired_at
    LEFT JOIN ca_pool p ON p.ca = a.ca
    ORDER BY a.fired_at DESC, a.id DESC`)
    .all(params) as (Omit<AlertRow, 'pushed' | 'payload'> & { pushed: number; payload: string;
      chain: string | null; symbol: string | null })[];
  const map = new Map<string, AlertGroup>();
  const pushedTags = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = JSON.stringify([row.ca, row.firedAt]);
    let group = map.get(key);
    if (!group) {
      group = { id: row.id, ca: row.ca, chain: row.chain ?? null, symbol: row.symbol ?? null,
        firedAt: row.firedAt, tags: [], payload: JSON.parse(row.payload) as unknown, pushed: false };
      map.set(key, group);
      pushedTags.set(key, new Set());
    }
    if (!group.tags.includes(row.tag)) group.tags.push(row.tag);
    if (row.pushed === 1) pushedTags.get(key)!.add(row.tag);
  }
  for (const [key, group] of map) group.pushed = group.tags.every((tag) => pushedTags.get(key)!.has(tag));
  return { items: [...map.values()], total };
}

/** 只读聚合；不触发任何计算或上游请求。since 之前的样本不计入。 */
export function queryOutcomes(db: StoreDatabase, since = 0): OutcomesResponse {
  const store = createOutcomeStore(db);
  const control = db.prepare(`SELECT MIN(baseline_at) AS first FROM alert_outcomes
    WHERE alerted = 0 AND return_pct IS NOT NULL`).get() as { first: number | null };
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM alert_outcomes
    WHERE return_pct IS NULL AND settled_at IS NULL`).get() as { n: number };
  const settled = db.prepare('SELECT MAX(settled_at) AS at FROM alert_outcomes').get() as { at: number | null };
  return { horizons: store.stats(since), tags: store.tagStats(since),
    controlSince: control.first, pending: pending.n, settledAt: settled.at };
}
