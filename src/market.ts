import type { AlertTag, Candle, MomentId } from './types.js';

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
export const INTERVAL_MS = { '15m': 15 * MINUTE_MS, '1h': HOUR_MS, '4h': 4 * HOUR_MS, '1d': 24 * HOUR_MS } as const;
export const PERIOD_MS = { '30m': 30 * MINUTE_MS, '60m': HOUR_MS, '4h': 4 * HOUR_MS } as const;
export type Period = keyof typeof PERIOD_MS;
export const PERIODS: Period[] = ['30m', '60m', '4h'];
export const RPS_KEYS = ['r16', 'r56', 'r96', 'r288', 'r672'] as const;
export type RpsKey = typeof RPS_KEYS[number];
export type RpsScores = Record<RpsKey, number | null>;
export const emptyScores = (): RpsScores => ({ r16: null, r56: null, r96: null, r288: null, r672: null });

export const BREAKOUTS = [
  { moment: 1, period: '30m', setting: 'a3_1_30m_ath', ath: true, tag: '30m_ath_pullback' },
  { moment: 2, period: '30m', setting: 'a3_2_30m_48bar', ath: false, tag: '30m_1d_high_pullback' },
  { moment: 3, period: '60m', setting: 'a3_3_60m_ath', ath: true, tag: '60m_ath_pullback' },
  { moment: 4, period: '60m', setting: 'a3_4_60m_48bar', ath: false, tag: '60m_2d_high_pullback' },
  { moment: 5, period: '4h', setting: 'a3_5_4h_ath', ath: true, tag: '4h_ath_pullback' },
  { moment: 6, period: '4h', setting: 'a3_6_4h_48bar', ath: false, tag: '4h_8d_high_pullback' },
] as const satisfies ReadonlyArray<{ moment: MomentId; period: Period; setting: string; ath: boolean; tag: AlertTag }>;

export const TAG_DETAILS: Record<AlertTag, { period: Period; label: string; icon: string }> = {
  '30m_ath_pullback': { period: '30m', label: '30分钟历史新高回调提醒', icon: '▲▲' },
  '30m_1d_high_pullback': { period: '30m', label: '30分钟一日新高回调', icon: '▲' },
  '60m_ath_pullback': { period: '60m', label: '60分钟历史新高回调', icon: '▲▲' },
  '60m_2d_high_pullback': { period: '60m', label: '60分钟两日新高回调', icon: '▲' },
  '4h_ath_pullback': { period: '4h', label: '4小时历史新高回调', icon: '▲▲' },
  '4h_8d_high_pullback': { period: '4h', label: '4小时八日新高回调', icon: '▲' },
  low_vol_30m: { period: '30m', label: '低量30分钟', icon: '▽' },
  low_vol_60m: { period: '60m', label: '低量60分钟', icon: '▽' },
  low_vol_4h: { period: '4h', label: '低量4小时', icon: '▽' },
  rsi_lt50_30m: { period: '30m', label: '30分钟RSI小于50', icon: '⊘' },
  rsi_lt50_60m: { period: '60m', label: '60分钟RSI小于50', icon: '⊘' },
  rsi_lt50_4h: { period: '4h', label: '4小时RSI小于50', icon: '⊘' },
};

/** 时间常量是周期单位，策略阈值由调用方传入。 */
export function closedCandles(candles: Candle[], intervalMs: number, now: number): Candle[] {
  return candles.filter((bar) => bar.openTime % intervalMs === 0 && bar.openTime + intervalMs <= now)
    .sort((a, b) => a.openTime - b.openTime);
}

export function contiguousTail(candles: Candle[], intervalMs: number): Candle[] {
  let start = candles.length - 1;
  while (start > 0 && candles[start]!.openTime - candles[start - 1]!.openTime === intervalMs) start--;
  return candles.slice(Math.max(start, 0));
}

/**
 * 最后一根收盘 K 线是否足够新。
 *
 * maxStaleBars 允许落后 N 个周期：全池拉取 132 个 CA 需约 80 秒，
 * 先拉到的数据在统一评估时可能已跨过周期边界。零容忍会把这些 CA 全部剔除出
 * RPS 排名（实测 r16/r56 覆盖率因此只有 16%）。
 */
export function isFresh(candles: Candle[], intervalMs: number, now: number, maxStaleBars = 0): boolean {
  const last = candles.at(-1)?.openTime;
  if (last === undefined) return false;
  const expected = Math.floor(now / intervalMs) * intervalMs - intervalMs;
  return last <= expected && expected - last <= maxStaleBars * intervalMs;
}
