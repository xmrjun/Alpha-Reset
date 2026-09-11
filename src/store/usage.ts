import type { StoreDatabase } from './db.js';

export interface UsageRow {
  date: string;
  calls: number;
  updatedAt: number;
}

export function createUsageStore(db: StoreDatabase) {
  const increment = db.prepare(`INSERT INTO api_usage (date, calls, updated_at) VALUES (?, 1, ?)
    ON CONFLICT (date) DO UPDATE SET calls = api_usage.calls + 1,
      updated_at = MAX(api_usage.updated_at, excluded.updated_at)`);
  const sync = db.prepare(`INSERT INTO api_usage (date, calls, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (date) DO UPDATE SET calls = MAX(api_usage.calls, excluded.calls),
      updated_at = MAX(api_usage.updated_at, excluded.updated_at)`);
  const select = db.prepare('SELECT date, calls, updated_at AS updatedAt FROM api_usage WHERE date = ?');

  return {
    incrementUsage(date: string, now: number): void {
      increment.run(date, now);
    },
    syncUsage(date: string, calls: number, now: number): void {
      if (!Number.isSafeInteger(calls) || calls < 0) throw new RangeError('calls 必须是非负整数');
      sync.run(date, calls, now);
    },
    getUsage(date: string): UsageRow | null {
      return (select.get(date) as UsageRow | undefined) ?? null;
    },
  };
}
