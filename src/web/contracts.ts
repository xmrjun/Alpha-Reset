import type { RpsScores } from '../market.js';
import type { RuleOutput } from '../rules/evaluate.js';
import type { PoolRow } from '../store/pool.js';
import type { AlertTag, BreakoutMoment, Candle } from '../types.js';

export interface PoolViewRow extends PoolRow {
  rpsScores: RpsScores;
  tags: AlertTag[];
  reasons: RuleOutput['reasons'];
  lastAlertAt: number | null;
}
export interface AlertGroup {
  id: number; ca: string; firedAt: number; tags: AlertTag[]; payload: unknown; pushed: boolean;
}
export interface IndicatorPoint { openTime: number; value: number }
export interface DetailResponse {
  pool: PoolRow;
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
    roundStatus: string | null;
    roundRunning: boolean;
    rpsCoverage: Record<string, { eligible: number; available: number; complete: boolean; source: string }> | null;
  };
  /** A4 各档的覆盖率门槛，前端用于解释「为何暂不计分」 */
  rpsMinCoverage: number;
  refreshMinutes: number;
  quotaWarningPercent: number;
}
