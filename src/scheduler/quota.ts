import type { StrategyConfig } from '../config/strategy.js';
import type { StoreDatabase } from '../store/db.js';
import { createUsageStore } from '../store/usage.js';

export function usageDate(now: number, timezone = 'UTC'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export class QuotaStopError extends Error {
  readonly code = 'QUOTA_STOP';
  constructor() { super('API 用量达到停止阈值'); }
}

export function createQuotaGuard(db: StoreDatabase, cfg: StrategyConfig, clock = Date.now, timezone = 'UTC') {
  const usage = createUsageStore(db);
  let limit = cfg.quota.dailyLimit;
  const state = (now: number) => {
    const used = usage.getUsage(usageDate(now, timezone))?.calls ?? 0;
    return { used, limit, degraded: used * 100 >= limit * cfg.quota.degradeAtPercent,
      halted: used * 100 >= limit * cfg.quota.haltAtPercent };
  };
  return {
    state,
    sync(used: number, dailyLimit: number, now: number) {
      limit = Math.min(cfg.quota.dailyLimit, dailyLimit);
      usage.syncUsage(usageDate(now, timezone), used, now);
    },
    onCall() {
      const now = clock();
      if (state(now).halted) throw new QuotaStopError();
      usage.incrementUsage(usageDate(now, timezone), now);
    },
  };
}
