import type { StrategyConfig } from '../config/strategy.js';
import { HOUR_MS } from '../market.js';
import type { PoolItem } from '../types.js';

export function checkPreconditions(input: { now: number; listedAt: number | null; pool: PoolItem }, cfg: StrategyConfig) {
  const { now, listedAt, pool } = input;
  return {
    a1: listedAt !== null && Number.isFinite(listedAt) && now - listedAt > cfg.a1_age.minHours * HOUR_MS,
    a2: pool.marketCap !== null && Number.isFinite(pool.marketCap)
      && pool.marketCap > cfg.a2_scale.marketCapMin && pool.marketCap < cfg.a2_scale.marketCapMax
      && pool.liquidity !== null && Number.isFinite(pool.liquidity) && pool.liquidity > cfg.a2_scale.liquidityMin,
  };
}
