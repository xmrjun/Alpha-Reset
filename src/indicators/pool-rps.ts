import type { StrategyConfig } from '../config/strategy.js';
import { INTERVAL_MS, RPS_KEYS, closedCandles, emptyScores, isFresh, type RpsScores } from '../market.js';
import type { Candle } from '../types.js';
import { rps } from './rps.js';

export interface RpsMember {
  ca: string;
  listedAt: number | null;
  candles15m: Candle[];
  candles60m: Candle[];
}

/** 全池先计算端点涨幅；小时线只在收盘时间精确一致时补足端点，不近似七天涨幅。 */
export function calculatePoolRps(members: RpsMember[], now: number, cfg: StrategyConfig): Map<string, RpsScores> {
  const result = new Map(members.map((member) => [member.ca, emptyScores()]));
  const changes = new Map(RPS_KEYS.map((key) => [key, new Map<string, number>()]));
  for (const member of members) {
    const bars = closedCandles(member.candles15m, INTERVAL_MS['15m'], now);
    if (!isFresh(bars, INTERVAL_MS['15m'], now)) continue;
    const latest = bars.at(-1)!;
    const prices = new Map<number, number>();
    for (const bar of closedCandles(member.candles60m, INTERVAL_MS['1h'], now)) {
      prices.set(bar.openTime + INTERVAL_MS['1h'], bar.close);
    }
    for (const bar of bars) prices.set(bar.openTime + INTERVAL_MS['15m'], bar.close);
    for (const key of RPS_KEYS) {
      const target = latest.openTime + INTERVAL_MS['15m'] - cfg.a4_rps.periods[key].bars * INTERVAL_MS['15m'];
      const start = prices.get(target);
      if (member.listedAt === null || member.listedAt > target || start === undefined || start <= 0
        || !Number.isFinite(start) || !Number.isFinite(latest.close) || latest.close < 0) continue;
      changes.get(key)!.set(member.ca, (latest.close / start - 1) * 100);
    }
  }
  for (const key of RPS_KEYS) {
    for (const [ca, score] of rps(changes.get(key)!)) result.get(ca)![key] = score;
  }
  return result;
}
