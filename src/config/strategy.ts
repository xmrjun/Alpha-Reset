import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const positiveInteger = z.number().int().positive();
const rsiValue = z.number().min(0).max(100);
const rpsWindow = z.strictObject({ bars: positiveInteger, hours: z.number().positive(), threshold: rsiValue })
  .refine((value) => value.hours === value.bars * 15 / 60);

export interface StrategyConfig {
  version: number;
  observeGroups: string[];
  pool: {
    historyDays: number;
    perGroupLimit: number;
    maxCandidates: number;
    rankBy: 'total_mentions';
  };
  a1_age: { minHours: number };
  a2_scale: { marketCapMin: number; marketCapMax: number; liquidityMin: number };
  a3_breakout: {
    lookbackBars: number;
    enabled: Record<'a3_1_30m_ath' | 'a3_2_30m_48bar' | 'a3_3_60m_ath'
      | 'a3_4_60m_48bar' | 'a3_5_4h_ath' | 'a3_6_4h_48bar', boolean>;
  };
  a4_rps: {
    minCoverage: number;
    minRanked: number;
    maxStaleBars: number;
    basisInterval: '15m';
    poolScope: 'observeGroups';
    skipWhenInsufficientHistory: boolean;
    periods: Record<'r16' | 'r56' | 'r96' | 'r288' | 'r672',
      { bars: number; hours: number; threshold: number }>;
  };
  pullback: { minBarsSinceHigh: number; maxRsi: number };
  supplementary: { volMaPeriod: number; rsiBelow: number };
  indicators: { rsiPeriod: number };
  kline: { source: 'geckoterminal'; requestsPerMinute: number; bars15m: number };
  schedule: { mainLoopMinutes: number;
    klineRefresh: { range24h: number; range7d: number; range30d: number } };
  quota: { dailyLimit: number; degradeAtPercent: number; haltAtPercent: number };
  alerting: { cooldownBars: number; mergeTagsPerCa: boolean };
}

const strategySchema: z.ZodType<StrategyConfig> = z.strictObject({
  version: z.literal(1),
  observeGroups: z.array(z.string().trim().min(1)).min(1),
  pool: z.strictObject({
    historyDays: positiveInteger.max(365),      // board/summary 的 days 上限
    perGroupLimit: positiveInteger.max(200),    // board/summary 的 limit 硬上限，超过会静默返回 0
    maxCandidates: positiveInteger,
    rankBy: z.literal('total_mentions'),
  }),
  a1_age: z.strictObject({ minHours: z.number().nonnegative() }),
  a2_scale: z.strictObject({ marketCapMin: z.number().nonnegative(),
    marketCapMax: z.number().positive(), liquidityMin: z.number().nonnegative() })
    .refine((value) => value.marketCapMax > value.marketCapMin),
  a3_breakout: z.strictObject({ lookbackBars: positiveInteger.min(2), enabled: z.strictObject({
    a3_1_30m_ath: z.boolean(), a3_2_30m_48bar: z.boolean(), a3_3_60m_ath: z.boolean(),
    a3_4_60m_48bar: z.boolean(), a3_5_4h_ath: z.boolean(), a3_6_4h_48bar: z.boolean(),
  }) }),
  a4_rps: z.strictObject({ minCoverage: z.number().gt(0).max(1), minRanked: positiveInteger.min(2), maxStaleBars: z.number().int().nonnegative(),
    basisInterval: z.literal('15m'), poolScope: z.literal('observeGroups'),
    skipWhenInsufficientHistory: z.boolean(), periods: z.strictObject({
      r16: rpsWindow, r56: rpsWindow, r96: rpsWindow, r288: rpsWindow, r672: rpsWindow,
    }) }),
  indicators: z.strictObject({ rsiPeriod: positiveInteger }),
  pullback: z.strictObject({ minBarsSinceHigh: positiveInteger, maxRsi: rsiValue }),
  supplementary: z.strictObject({ volMaPeriod: positiveInteger, rsiBelow: rsiValue }),
  kline: z.strictObject({ source: z.literal('geckoterminal'),
    requestsPerMinute: positiveInteger.max(30), bars15m: positiveInteger.max(1000) }),
  schedule: z.strictObject({ mainLoopMinutes: positiveInteger, klineRefresh: z.strictObject({
    range24h: positiveInteger, range7d: positiveInteger, range30d: positiveInteger,
  }) }),
  quota: z.strictObject({ dailyLimit: positiveInteger,
    degradeAtPercent: z.number().gt(0).lt(100), haltAtPercent: z.number().gt(0).lte(100) })
    .refine((value) => value.degradeAtPercent < value.haltAtPercent),
  alerting: z.strictObject({ cooldownBars: positiveInteger, mergeTagsPerCa: z.boolean() }),
}).refine((value) => value.supplementary.rsiBelow <= value.pullback.maxRsi);

export class StrategyConfigError extends Error {
  readonly code = 'STRATEGY_CONFIG_INVALID';
}

/** 按架构的 summary + 差异化 K 线预算计算，监控/重试另由运行时额度保护。 */
export function poolCapacity(cfg: StrategyConfig, dailyLimit = cfg.quota.dailyLimit) {
  const roundsPerDay = Math.ceil(24 * 60 / cfg.schedule.mainLoopMinutes);
  const summaryCalls = roundsPerDay * new Set(cfg.observeGroups).size;
  const klineCallsPerCa = Object.values(cfg.schedule.klineRefresh)
    .reduce((total, rounds) => total + Math.ceil(roundsPerDay / rounds), 0);
  const maxCandidates = Math.max(0, Math.floor((Math.min(cfg.quota.dailyLimit, dailyLimit) - summaryCalls) / klineCallsPerCa));
  return { roundsPerDay, summaryCalls, klineCallsPerCa, maxCandidates };
}

export function assertPoolCapacity(cfg: StrategyConfig, dailyLimit = cfg.quota.dailyLimit): void {
  const budget = poolCapacity(cfg, dailyLimit);
  if (cfg.pool.maxCandidates > budget.maxCandidates) {
    throw new StrategyConfigError(`pool.maxCandidates=${cfg.pool.maxCandidates} 超出配额容量；建议最多 ${budget.maxCandidates} 个 CA`);
  }
}

function withoutComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutComments);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !key.startsWith('$comment'))
      .map(([key, entry]) => [key, withoutComments(entry)]));
  }
  return value;
}

/** 显式读取配置；规则层只 import type，并由调用方传入 cfg。 */
/**
 * 读取策略配置。
 *
 * 优先 `config/strategy.local.json`（私有：真实观察组与阈值，已 gitignore），
 * 缺失时回落到 `config/strategy.json`（示例：进仓库，仅供说明格式）。
 * 这样仓库可以公开，而具体监控哪些群、用什么阈值不外泄。
 */
export function loadStrategy(filename?: string): StrategyConfig {
  const path = filename ?? [resolve('config/strategy.local.json'), resolve('config/strategy.json')]
    .find((candidate) => existsSync(candidate)) ?? resolve('config/strategy.json');
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch { throw new StrategyConfigError('无法读取策略配置，或 JSON 格式无效'); }
  const result = strategySchema.safeParse(withoutComments(raw));
  if (!result.success) throw new StrategyConfigError('策略配置缺少必填项、存在未知字段或阈值无效');
  assertPoolCapacity(result.data);
  return result.data;
}
