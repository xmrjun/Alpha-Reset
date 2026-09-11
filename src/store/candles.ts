import type { Candle, Interval } from '../types.js';
import type { StoreDatabase } from './db.js';

export function createCandleStore(db: StoreDatabase) {
  const upsert = db.prepare(`
    INSERT INTO candles (ca, interval, open_time, open, high, low, close, volume)
    VALUES (@ca, @interval, @openTime, @open, @high, @low, @close, @volume)
    ON CONFLICT (ca, interval, open_time) DO UPDATE SET
      open = excluded.open, high = excluded.high, low = excluded.low,
      close = excluded.close, volume = excluded.volume
  `);
  const select = db.prepare(`
    SELECT open_time AS openTime, open, high, low, close, volume FROM candles
    WHERE ca = ? AND interval = ? ORDER BY open_time DESC LIMIT ?
  `);

  return {
    upsertCandles: db.transaction((ca: string, interval: Interval, candles: Candle[]): void => {
      for (const candle of candles) upsert.run({ ...candle, ca, interval });
    }),

    /** 按契约倒序返回；指标计算前须在调用层转为升序。省略 limit 查询全部历史。 */
    getCandles(ca: string, interval: Interval, limit?: number): Candle[] {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
        throw new RangeError('limit 必须是非负整数');
      }
      return select.all(ca, interval, limit ?? -1) as Candle[];
    },
  };
}
