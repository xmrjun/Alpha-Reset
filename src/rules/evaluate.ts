import type { StrategyConfig } from '../config/strategy.js';
import { detectHigh } from '../indicators/breakout.js';
import { rsi } from '../indicators/rsi.js';
import { sma } from '../indicators/sma.js';
import type { RpsBounds } from '../indicators/observation-rps.js';
import { BREAKOUTS, PERIODS, PERIOD_MS, RPS_KEYS, closedCandles, contiguousTail, isFresh } from '../market.js';
import { checkPreconditions } from './preconditions.js';
import type { RpsScores } from '../market.js';
import type { AlertTag, BreakoutMoment, Candle, PoolItem } from '../types.js';

export interface RuleInput {
  ca: string;
  now: number;
  cfg: StrategyConfig;
  pool: PoolItem;
  candles30m: Candle[];
  candles60m: Candle[];
  candles4h: Candle[];
  rpsScores: RpsScores;
  /** 缺数时仅下界超过阈值的完整池区间可触发。 */
  rpsBounds?: RpsBounds;
  listedAt: number | null;
  moments: BreakoutMoment[];
}

export interface RuleOutput {
  passed: boolean;
  reasons: { a1: boolean; a2: boolean; a3: boolean; a4: boolean };
  newMoments: BreakoutMoment[];
  tags: AlertTag[];
}

export function evaluate(input: RuleInput): RuleOutput {
  const { cfg, now, pool } = input;
  const supplied = { '30m': input.candles30m, '60m': input.candles60m, '4h': input.candles4h };
  const frames = PERIODS.map((period) => {
    const all = closedCandles(supplied[period], PERIOD_MS[period], now);
    const recent = contiguousTail(all, PERIOD_MS[period]);
    return { period, all, recent, fresh: isFresh(all, PERIOD_MS[period], now),
      strength: rsi(recent, cfg.indicators.rsiPeriod).at(-1),
      volumeMa: sma(recent.map((bar) => bar.volume), cfg.supplementary.volMaPeriod).at(-1) };
  });
  const moments = new Map(input.moments.filter((moment) => {
    const rule = BREAKOUTS.find((entry) => entry.moment === moment.moment);
    return rule && moment.barTime % PERIOD_MS[rule.period] === 0
      && moment.barTime + PERIOD_MS[rule.period] <= now && Number.isFinite(moment.price);
  })
    .map((moment) => [moment.moment, moment]));
  const newMoments: BreakoutMoment[] = [];

  for (const rule of BREAKOUTS) {
    if (!cfg.a3_breakout.enabled[rule.setting]) continue;
    const frame = frames.find((entry) => entry.period === rule.period)!;
    if (!frame.fresh) continue;
    const bars = rule.ath ? frame.all : frame.recent;
    const index = detectHigh(bars, rule.ath ? Infinity : cfg.a3_breakout.lookbackBars);
    if (index === null) continue;
    const bar = bars[index]!;
    const previous = moments.get(rule.moment);
    if (rule.ath && previous && previous.price >= bar.high) continue;
    if (previous && (previous.barTime > bar.openTime
      || (previous.barTime === bar.openTime && previous.price >= bar.high))) continue;
    const moment = { moment: rule.moment, barTime: bar.openTime, price: bar.high };
    moments.set(rule.moment, moment);
    newMoments.push(moment);
  }

  const reasons = {
    ...checkPreconditions({ now, listedAt: input.listedAt, pool }, cfg),
    a3: BREAKOUTS.some((rule) => cfg.a3_breakout.enabled[rule.setting] && moments.has(rule.moment)),
    a4: RPS_KEYS.some((key) => {
      const score = input.rpsScores[key];
      const bound = input.rpsBounds?.[key];
      return (score !== null && Number.isFinite(score) && score > cfg.a4_rps.periods[key].threshold)
        || Boolean(bound && (bound.status === 'pass' || bound.status === 'exact')
          && Number.isFinite(bound.lower) && Number.isFinite(bound.upper)
          && bound.lower >= 0 && bound.upper <= 100 && bound.lower <= bound.upper
          && bound.lower > cfg.a4_rps.periods[key].threshold);
    }),
  };
  const passed = Object.values(reasons).every(Boolean);
  const tags: AlertTag[] = [];
  if (!passed) return { passed, reasons, newMoments, tags };

  for (const rule of BREAKOUTS) {
    const moment = moments.get(rule.moment);
    const frame = frames.find((entry) => entry.period === rule.period)!;
    if (!cfg.a3_breakout.enabled[rule.setting] || !moment || !frame.fresh || frame.strength === undefined) continue;
    const afterHigh = frame.recent.filter((bar) => bar.openTime > moment.barTime).length;
    if (afterHigh >= cfg.pullback.minBarsSinceHigh && frame.strength <= cfg.pullback.maxRsi) tags.push(rule.tag);
  }
  for (const frame of frames) {
    if (!frame.fresh) continue;
    const last = frame.recent.at(-1)!;
    if (last.close < last.open && frame.volumeMa !== undefined && last.volume <= frame.volumeMa) {
      tags.push(`low_vol_${frame.period}`);
    }
    if (frame.strength !== undefined && frame.strength < cfg.supplementary.rsiBelow) {
      tags.push(`rsi_lt50_${frame.period}`);
    }
  }
  return { passed, reasons, newMoments, tags };
}
