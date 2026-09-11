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
  dataQuality: { mayBeTruncated: boolean; freshPriceCount: number; rpsAvailable: boolean };
  refreshMinutes: number;
  quotaWarningPercent: number;
}
