import type { RpsScores } from '../market.js';
import type { RpsBounds } from '../indicators/observation-rps.js';
import type { MarketSeries } from '../store/series.js';
import type { RpsCoverage } from '../store/runtime.js';
import type { RuleOutput } from '../rules/evaluate.js';
import type { PoolRow } from '../store/pool.js';
import type { AlertTag, BreakoutMoment, Candle } from '../types.js';

export interface RpsDisplaySummary {
  state: 'current' | 'previous' | 'stale';
  /** 评分使用的统一收盘时刻，非请求完成时间。 */
  asOf: number;
  computedAt: number;
  poolSize: number;
  coverage: Record<string, RpsCoverage>;
}
export interface DisplayRps extends Omit<RpsDisplaySummary, 'coverage'> {
  source?: ScoringSource;
  scores: RpsScores;
  bounds?: RpsBounds;
}
export type ScoringSource = 'gmgn' | 'geckoterminal';
export interface PoolViewRow extends PoolRow {
  /** 当前固定 T 的实际评分来源；没有匹配计算时为 null。 */
  scoreSource?: ScoringSource | null;
  rpsScores: RpsScores;
  rpsBounds?: RpsBounds;
  /** 仅供显示；旧轮次值绝不传入规则或通知。 */
  displayRps?: DisplayRps | null;
  /** 最新观察名单中尚未匹配到当前固定时点计算的成员。 */
  calculationPending?: boolean;
  tags: AlertTag[];
  reasons: RuleOutput['reasons'];
  lastAlertAt: number | null;
}
export interface AlertGroup {
  id: number; ca: string; firedAt: number; tags: AlertTag[]; payload: unknown; pushed: boolean;
  /** 供前端构造 DexScreener / GMGN 外链，避免为此再请求详情接口 */
  chain: string | null; symbol: string | null;
}
export interface IndicatorPoint { openTime: number; value: number }
export interface DetailResponse {
  pool: PoolRow;
  marketSeries?: MarketSeries | null;
  historyStartedAt?: number | null;
  candles: Candle[];
  indicators: {
    rsi: IndicatorPoint[];
    volumeMa: IndicatorPoint[];
    parameters: { rsiPeriod: number; volMaPeriod: number; rsiBelow: number; maxRsi: number };
  };
  moments: BreakoutMoment[];
  alerts: AlertGroup[];
}
export interface PoolResponse { items: PoolViewRow[]; total: number; updatedAt: number }
export interface AlertsResponse { items: AlertGroup[]; total: number }
export interface StatsResponse {
  poolSize: number; alertsToday: number; quota: { used: number; limit: number }; lastRunAt: number | null;
  dataQuality: {
    mayBeTruncated: boolean;
    freshPriceCount: number;
    /** 本轮实际监控的标的数 —— 分母用它，不要用 ca_pool 的历史累计 */
    monitored: number;
    observeGroups: number;
    rpsAvailable: boolean;
    /** 本轮达标、参与计分的 RPS 档位 */
    rpsReadyKeys: string[];
    /** 有可证明达标下界的档位，不冒充完整排名。 */
    rpsBoundedKeys?: string[];
    roundStatus: string | null;
    rpsFromPreviousRound: boolean;
    roundRunning: boolean;
    rpsCoverage: Record<string, RpsCoverage> | null;
    rpsDisplay?: RpsDisplaySummary | null;
    observation?: {
      sourceCount: number;
      memberCount: number;
      updatedAt: number | null;
      refreshMinutes: number;
      upstreamLimited: boolean;
      /** 当前配置的最近发现尝试；updatedAt 仍是最后完整名单的成功时间。 */
      discoveryStatus?: 'running' | 'complete' | 'partial' | 'halted' | 'failed' | null;
      discoveryFailures?: number;
      lastAttemptAt?: number | null;
      addedCount?: number;
      removedCount?: number;
    };
    enabledSources?: readonly ScoringSource[];
    gmgn?: {
      enabled: boolean;
      status: 'running' | 'idle' | 'cooldown' | 'auth_error' | 'disabled' | null;
      updatedAt: number | null;
      effectiveRpm: number;
      /** 累计采集任务调用数，不含客户端内部重试次数。 */
      requests: number;
      recentRequests: number;
      historyRequests: number;
      /** 计划范围已查询，不保证响应在所有时间点连续。 */
      assetsWithHistory: number;
      /** 已入采集队列且范围未查完的资产，不含尚未入队的候选。 */
      backfillPending: number;
      cooldownUntil: number;
    };
    calculation?: { memberCount: number; asOf: number | null; computedAt: number | null;
      sources?: { gmgn: number; geckoterminal: number; unbound: number } };

    collection?: {
      source?: 'geckoterminal';
      /** 正在遍历的固定队列；可能不同于最新观察名单。 */
      memberCount?: number;
      effectiveRpm?: number;
      minSweepMinutes?: number;
      boardComplete: boolean;
      baselineAt: number | null;
      processed: number;
      succeeded: number;
      failed: number;
      historyAvailable: number;
    };
  };
  /** A4 各档的覆盖率门槛，前端用于解释「为何暂不计分」 */
  rpsMinCoverage: number;
  /** 基准前多少根 15m 无成交即判失活剔除，供页面说明覆盖率口径。 */
  inactiveAfterBars?: number;
  refreshMinutes: number;
  revisionMinutes?: number;
  quotaWarningPercent: number;
}
