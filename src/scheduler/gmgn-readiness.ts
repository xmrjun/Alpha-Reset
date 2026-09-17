import type { StrategyConfig } from '../config/strategy.js';
import { aggregateCandles } from '../indicators/merge.js';
import { INTERVAL_MS, PERIOD_MS, PERIODS, RPS_KEYS, closedCandles, contiguousTail, type RpsKey, type Period } from '../market.js';
import type { Candle } from '../types.js';

export interface SeriesHistory {
  candles15m: Candle[];
  candles60m: Candle[];
  candles4h: Candle[];
}
export interface GmgnReadiness {
  ready: boolean;
  /** 候选确有已闭合正价，且除当前端点外全部切换历史要求达标。 */
  historyReady: boolean;
  missingCurrent: boolean;
  missingStarts: RpsKey[];
  missingPeriods: Period[];
}

function validClosed(bars: Candle[], interval: number, now: number): Candle[] {
  return closedCandles(bars, interval, now).filter((bar) => Number.isFinite(bar.close) && bar.close > 0);
}
function prices(history: SeriesHistory, now: number): Map<number, number> {
  const result = new Map<number, number>();
  for (const [bars, interval] of [[history.candles60m, INTERVAL_MS['1h']], [history.candles15m, INTERVAL_MS['15m']]] as const) {
    for (const bar of validClosed(bars, interval, now)) result.set(bar.openTime + interval, bar.close);
  }
  return result;
}
function frames(history: SeriesHistory, now: number): Record<Period, Candle[]> {
  return {
    '30m': aggregateCandles(validClosed(history.candles15m, INTERVAL_MS['15m'], now), INTERVAL_MS['15m'], PERIOD_MS['30m']),
    '60m': validClosed(history.candles60m, INTERVAL_MS['1h'], now),
    '4h': validClosed(history.candles4h, INTERVAL_MS['4h'], now),
  };
}

/** 纯函数：每份输入必须来自一个已验证来源；只判断切换准备度，不拼接任何历史。 */
export function gmgnReadiness(input: { candidate: SeriesHistory; previous: SeriesHistory | null;
  listedAt: number | null; now: number; cfg: StrategyConfig }): GmgnReadiness {
  const { candidate, previous, listedAt, now, cfg } = input;
  const baseline = Math.floor(now / INTERVAL_MS['15m']) * INTERVAL_MS['15m'];
  const candidatePrices = prices(candidate, baseline);
  const previousPrices = previous ? prices(previous, baseline) : new Map<number, number>();
  const missingCurrent = !candidatePrices.has(baseline);
  const result: GmgnReadiness = { ready: false, historyReady: false, missingCurrent, missingStarts: [], missingPeriods: [] };
  if (!candidatePrices.size) return result;
  // 没有既存可用行情的新资产可先绑定真实历史；缺少端点仍由全池 RPS 保留为未知。
  if (!previousPrices.size) return { ...result, ready: true, historyReady: true };
  // 候选自身最早的已知收盘时刻，用于区分「区间内无成交」与「深度不足」。
  let candidateFirst = Infinity;
  for (const stamp of candidatePrices.keys()) candidateFirst = Math.min(candidateFirst, stamp);
  let firstKnown = Infinity;
  for (const stamp of candidatePrices.keys()) firstKnown = Math.min(firstKnown, stamp);
  for (const stamp of previousPrices.keys()) firstKnown = Math.min(firstKnown, stamp);
  const knownListing = listedAt !== null && Number.isFinite(listedAt) && listedAt >= 0 && listedAt <= baseline;
  for (const key of RPS_KEYS) {
    const target = baseline - cfg.a4_rps.periods[key].bars * INTERVAL_MS['15m'];
    // 未知上市年龄可能适龄，不能凭历史回补得少就跳过长窗口。
    const required = !knownListing || listedAt! <= target || firstKnown <= target;
    // 区分两种「缺起点」：
    //   覆盖范围内的空洞 —— 该 15m 区间没有成交，任何来源都不会有这根收盘价。
    //     旧来源同样缺时不构成阻塞，否则等于要求候选补上一根连现任都拿不出的 K 线，
    //     迁移会被永久卡死（实测 62 个缺起点成员里 55 个属于此类）。
    //   深度不足 —— 候选的数据根本没回溯到该时点，这是真实短板，必须继续阻塞。
    const shallower = candidateFirst > target;
    if (required && !candidatePrices.has(target) && (previousPrices.has(target) || shallower)) {
      result.missingStarts.push(key);
    }
  }
  const oldFrames = frames(previous!, baseline);
  const nextFrames = frames(candidate, baseline);
  const sufficient = cfg.a3_breakout.lookbackBars + 1;
  for (const period of PERIODS) {
    const oldLength = contiguousTail(oldFrames[period], PERIOD_MS[period]).length;
    const nextLength = contiguousTail(nextFrames[period], PERIOD_MS[period]).length;
    const oldClose = oldFrames[period].at(-1)?.openTime ?? -Infinity;
    const nextClose = nextFrames[period].at(-1)?.openTime ?? -Infinity;
    if (nextLength < Math.min(oldLength, sufficient) || nextClose < oldClose) result.missingPeriods.push(period);
  }
  result.historyReady = !result.missingStarts.length && !result.missingPeriods.length;
  result.ready = !missingCurrent && result.historyReady;
  return result;
}
