import type { StrategyConfig } from '../config/strategy.js';
import { INTERVAL_MS, RPS_KEYS, closedCandles, emptyScores, type RpsKey } from '../market.js';
import type { DexSnapshot } from '../types.js';
import type { RpsMember } from './pool-rps.js';
import { rps } from './rps.js';

export interface ObservationRpsMember extends RpsMember {
  // 保留输入兼容；五档排名均不再使用滚动行情快照。
  dex: DexSnapshot | null;
  dexStatus: 'pending' | 'ok' | 'error' | 'absent';
}

export interface RpsBound {
  lower: number;
  upper: number;
  status: 'exact' | 'pass' | 'fail' | 'unknown';
}
export type RpsBounds = Record<RpsKey, RpsBound | null>;
export const emptyBounds = (): RpsBounds => ({ r16: null, r56: null, r96: null, r288: null, r672: null });
export interface ObservationRpsCoverage {
  eligible: number;
  available: number;
  complete: boolean;
  source: 'kline';
  unknownAge: number;
  /** 基准前 inactiveAfterBars 根内无任何已收盘价，已从分母剔除的成员数。 */
  inactive: number;
  /** Dex 日期不能证明该窗口存续，但已验证历史可以证明的成员数。 */
  ageConfirmedByHistory: number;
  missingCurrent: number;
  missingStart: number;
  boundedPassCount: number;
}

/** 同一已验证行情序列、同一收盘时刻；缺失价格不缩小全池排名分母。 */
export function calculateObservationRps(members: ObservationRpsMember[], now: number, cfg: StrategyConfig) {
  const scores = new Map(members.map((member) => [member.ca, emptyScores()]));
  const bounds = new Map(members.map((member) => [member.ca, emptyBounds()]));
  // 数学范围可供观察；未达到策略门槛时不进入bounds/scores，也不能标为通过。
  const displayBounds = new Map(members.map((member) => [member.ca, emptyBounds()]));
  const coverage = {} as Record<RpsKey, ObservationRpsCoverage>;
  const baseline = Math.floor(now / INTERVAL_MS['15m']) * INTERVAL_MS['15m'];
  const history = new Map(members.map((member) => {
    const prices = new Map<number, number>();
    for (const bar of closedCandles(member.candles60m, INTERVAL_MS['1h'], baseline)) {
      if (Number.isFinite(bar.close) && bar.close > 0) prices.set(bar.openTime + INTERVAL_MS['1h'], bar.close);
    }
    for (const bar of closedCandles(member.candles15m, INTERVAL_MS['15m'], baseline)) {
      if (Number.isFinite(bar.close) && bar.close > 0) prices.set(bar.openTime + INTERVAL_MS['15m'], bar.close);
    }
    let firstCloseTime = Infinity;
    let lastCloseTime = -Infinity;
    for (const closeTime of prices.keys()) {
      firstCloseTime = Math.min(firstCloseTime, closeTime);
      lastCloseTime = Math.max(lastCloseTime, closeTime);
    }
    return [member.ca, { prices, firstCloseTime, lastCloseTime }];
  }));

  // 失活基准对所有档位一致：没有 close(T) 的资产在任何窗口都算不出涨幅。
  const staleBefore = baseline - cfg.a4_rps.inactiveAfterBars * INTERVAL_MS['15m'];
  for (const key of RPS_KEYS) {
    const target = baseline - cfg.a4_rps.periods[key].bars * INTERVAL_MS['15m'];
    let unknownAge = 0;
    let inactive = 0;
    let ageConfirmedByHistory = 0;
    const eligible = members.filter((member) => {
      // 失活剔除只依据已验证的证据，绝不因为「本地还没抓到」就缩小分母：
      //   有历史 → 上游最新已收盘价早于 staleBefore，说明该池已停止成交；
      //   无历史 → 仅当上游明确应答「该 CA 无任何交易对」(dexStatus=absent) 才剔除。
      // 采集中断只会让 dexStatus 变成 error/pending，成员仍留在分母，
      // 覆盖率随之下降并触发 minCoverage 失败，不会被误判成个别资产失活。
      const { lastCloseTime } = history.get(member.ca)!;
      const hasHistory = lastCloseTime > -Infinity;
      if (hasHistory ? lastCloseTime < staleBefore : member.dexStatus === 'absent') { inactive++; return false; }
      const dexConfirmsAge = member.listedAt !== null && Number.isFinite(member.listedAt)
        && member.listedAt <= target;
      // 调用方只提供同链、同 CA、同固定池的已验证序列。历史正价证明“当时已存在”，
      // 不推断真实上市日，也不改写 A1 所用 listedAt；必须比较收盘时间而非开盘时间。
      const historyConfirmsAge = history.get(member.ca)!.firstCloseTime <= target;
      if (historyConfirmsAge) {
        if (!dexConfirmsAge) ageConfirmedByHistory++;
        return true;
      }
      if (dexConfirmsAge) return true;
      if (member.listedAt === null || !Number.isFinite(member.listedAt) || member.listedAt > baseline) unknownAge++;
      return false;
    });
    const changes = new Map<string, number>();
    let missingCurrent = 0;
    let missingStart = 0;
    for (const member of eligible) {
      const prices = history.get(member.ca)!.prices;
      const current = prices.get(baseline);
      const start = prices.get(target);
      if (current === undefined) missingCurrent++;
      if (start === undefined) missingStart++;
      if (current !== undefined && start !== undefined) {
        const change = (current / start - 1) * 100;
        if (Number.isFinite(change)) changes.set(member.ca, change);
      }
    }
    // 本窗口仍无法证明年龄者可能适龄：全部保留在潜在分母，不能静默缩小排名池。
    const possibleEligible = eligible.length + unknownAge;
    const ratio = possibleEligible ? changes.size / possibleEligible : 0;
    const usable = changes.size >= cfg.a4_rps.minRanked && ratio >= cfg.a4_rps.minCoverage;
    const complete = usable && unknownAge === 0 && changes.size === eligible.length;
    const item: ObservationRpsCoverage = { eligible: possibleEligible, available: changes.size,
      complete, source: 'kline', unknownAge, inactive, ageConfirmedByHistory, missingCurrent, missingStart, boundedPassCount: 0 };
    coverage[key] = item;
    const exactScores = complete ? rps(changes) : null;
    for (const [ca, change] of changes) {
      const rank = 1 + [...changes.values()].filter((other) => other > change).length;
      const missing = possibleEligible - changes.size;
      const lower = (1 - (rank + missing) / possibleEligible) * 100;
      const upper = (1 - rank / possibleEligible) * 100;
      const threshold = cfg.a4_rps.periods[key].threshold;
      const status = complete ? 'exact' : usable && lower > threshold ? 'pass' : upper <= threshold ? 'fail' : 'unknown';
      displayBounds.get(ca)![key] = { lower, upper, status };
      if (usable) bounds.get(ca)![key] = { lower, upper, status };
      if (complete) scores.get(ca)![key] = exactScores!.get(ca)!;
      if (status === 'pass') item.boundedPassCount++;
    }
  }
  return { scores, bounds, displayBounds, coverage };
}
