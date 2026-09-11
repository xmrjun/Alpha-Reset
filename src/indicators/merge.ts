import type { Candle } from '../types.js';

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const THIRTY_MINUTES = 2 * FIFTEEN_MINUTES;

/** 按半小时边界配对；缺失、未对齐的 bar 不可跨桶拼接。 */
export function merge15mTo30m(candles: Candle[]): Candle[] {
  const byTime = new Map(candles.map((candle) => [candle.openTime, candle]));
  const result: Candle[] = [];

  for (const time of [...byTime.keys()].sort((a, b) => a - b)) {
    if (time % THIRTY_MINUTES !== 0) continue;
    const first = byTime.get(time)!;
    const second = byTime.get(time + FIFTEEN_MINUTES);
    if (!second) continue;
    result.push({
      openTime: time,
      open: first.open,
      high: Math.max(first.high, second.high),
      low: Math.min(first.low, second.low),
      close: second.close,
      volume: first.volume + second.volume,
    });
  }
  return result;
}
