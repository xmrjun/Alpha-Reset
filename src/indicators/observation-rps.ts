import type { StrategyConfig } from '../config/strategy.js';
import { HOUR_MS, INTERVAL_MS, RPS_KEYS, closedCandles, emptyScores, isFresh, type RpsKey, type RpsScores } from '../market.js';
import type { DexSnapshot } from '../types.js';
import type { RpsMember } from './pool-rps.js';
import { rps } from './rps.js';

export interface ObservationRpsMember extends RpsMember {
  dex: DexSnapshot | null;
  dexStatus: 'pending' | 'ok' | 'error';
}

/**
 * 在容差内取最接近目标时刻的收盘价。
 *
 * 必要性：15m K 线只覆盖最近 24h，更早的端点只能落在 1h 线的整点上，
 * 而 target 是按 15m 网格推算的。若要求精确命中，只有当前网格恰好在整点时
 * 才取得到——其余 3/4 的时间 r288/r672 必然为 0 覆盖（实测确实是 0/115、0/94）。
 */
export function priceAt(prices: Map<number, number>, target: number, toleranceMs: number): number | undefined {
  const exact = prices.get(target);
  if (exact !== undefined) return exact;
  let best: number | undefined;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const [time, price] of prices) {
    const gap = Math.abs(time - target);
    if (gap <= toleranceMs && gap < bestGap) { bestGap = gap; best = price; }
  }
  return best;
}

/** 不用 A1/A2 子集替换排名池。适龄 CA 缺失价格时，整档留空而非缩小分母。 */
export function calculateObservationRps(members: ObservationRpsMember[], now: number, cfg: StrategyConfig) {
  const scores = new Map(members.map((member) => [member.ca, emptyScores()]));
  const coverage = {} as Record<RpsKey, { eligible: number; available: number; complete: boolean; source: 'dex_h24' | 'kline' }>;
  const history = new Map(members.map((member) => {
    const bars = closedCandles(member.candles15m, INTERVAL_MS['15m'], now);
    const prices = new Map<number, number>();
    for (const bar of closedCandles(member.candles60m, INTERVAL_MS['1h'], now)) prices.set(bar.openTime + INTERVAL_MS['1h'], bar.close);
    for (const bar of bars) prices.set(bar.openTime + INTERVAL_MS['15m'], bar.close);
    return [member.ca, { prices, current: isFresh(bars, INTERVAL_MS['15m'], now, cfg.a4_rps.maxStaleBars) ? bars.at(-1)! : null }];
  }));
  for (const key of RPS_KEYS) {
    const useDex = key === 'r96' && cfg.a4_rps.periods[key].hours * HOUR_MS === INTERVAL_MS['1d'];
    const changes = new Map<string, number>();
    const target = Math.floor(now / INTERVAL_MS['15m']) * INTERVAL_MS['15m'] - cfg.a4_rps.periods[key].bars * INTERVAL_MS['15m'];
    const eligible = members.filter((member) => member.listedAt !== null && Number.isFinite(member.listedAt)
      && member.listedAt <= (useDex ? now - INTERVAL_MS['1d'] : target));
    for (const member of eligible) {
      if (useDex) {
        const change = member.dex?.priceChange.h24;
        if (member.dexStatus === 'ok' && change != null && Number.isFinite(change)) changes.set(member.ca, change);
      } else {
        const data = history.get(member.ca)!;
        // 端点超出 15m 线的 24h 覆盖范围时放宽到 1h 容差（此时只能取 1h 线的整点）
        const span = cfg.a4_rps.periods[key].bars * INTERVAL_MS['15m'];
        const price = priceAt(data.prices, target, span > INTERVAL_MS['1d'] ? INTERVAL_MS['1h'] : INTERVAL_MS['15m']);
        if (data.current && price !== undefined && price > 0 && Number.isFinite(price) && Number.isFinite(data.current.close)) {
          changes.set(member.ca, (data.current.close / price - 1) * 100);
        }
      }
    }
    // 覆盖率阈值：上游约 55% 的 CA 无 K 线数据(status=unavailable)。
    // 若要求“全池无一缺失”，该档 RPS 永远算不出来，A4 恒假，系统永不告警。
    const ratio = eligible.length > 0 ? changes.size / eligible.length : 0;
    const complete = ratio >= cfg.a4_rps.minCoverage && changes.size >= cfg.a4_rps.minRanked;
    coverage[key] = { eligible: eligible.length, available: changes.size, complete, source: useDex ? 'dex_h24' : 'kline' };
    if (complete) for (const [ca, score] of rps(changes)) scores.get(ca)![key] = score;
  }
  return { scores: scores as Map<string, RpsScores>, coverage };
}
