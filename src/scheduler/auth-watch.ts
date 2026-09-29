import { z } from 'zod';
import type { StoreDatabase } from '../store/db.js';

/** 采集器自己会每 30 分钟复查，一小时内恢复的抖动不打扰人。 */
export const AUTH_ALERT_AFTER_MS = 60 * 60_000;
export const AUTH_REMIND_MS = 6 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

const SOURCES = [
  { key: 'binance_auth_error', label: 'Binance Web3（xapi）' },
  { key: 'gmgn_auth_error', label: 'GMGN' },
] as const;

const latchSchema = z.object({
  httpStatus: z.number(), at: z.number().int().nonnegative(), since: z.number().int().nonnegative().optional(),
});

/** 数据源鉴权停摆（多半是 API 余额耗尽）时通知运维；自动重试无法替人充值。 */
export function createAuthWatch(opts: { db: StoreDatabase; alert: (message: string) => Promise<void> }) {
  const select = opts.db.prepare('SELECT payload FROM runtime_state WHERE key = ?');
  const alertedAt = new Map<string, number>();

  function readLatch(key: string) {
    const row = select.get(key) as { payload: string } | undefined;
    if (!row) return null;
    try {
      const parsed = latchSchema.safeParse(JSON.parse(row.payload));
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  }

  return {
    async check(now: number): Promise<void> {
      for (const { key, label } of SOURCES) {
        try {
          const latch = readLatch(key);
          const last = alertedAt.get(key);
          if (latch) {
            const down = now - (latch.since ?? latch.at);
            if (down < AUTH_ALERT_AFTER_MS || (last !== undefined && now - last < AUTH_REMIND_MS)) continue;
            await opts.alert(`Alpha-Reset：${label} 鉴权失败（HTTP ${latch.httpStatus}），已持续 ${Math.floor(down / HOUR_MS)} 小时，`
              + '期间该来源的行情停止更新。多为 API 余额耗尽或密钥失效；采集器每 30 分钟自动复查，恢复后会再通知。');
            alertedAt.set(key, now);
          } else if (last !== undefined) {
            await opts.alert(`Alpha-Reset：${label} 鉴权已恢复，行情采集继续。`);
            alertedAt.delete(key);
          }
        } catch { /* 通知通道故障：不记为已告警，下一次检查重试。 */ }
      }
    },
  };
}
