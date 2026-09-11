import type { Candle } from '../types.js';

/** lookback 包含当前 bar；有限窗口不足时跳过，持平不算创新高。 */
export function detectHigh(candles: Candle[], lookback: number): number | null {
  if (lookback !== Infinity && (!Number.isSafeInteger(lookback) || lookback < 1)) {
    throw new RangeError('lookback 必须是正整数或 Infinity');
  }
  const size = lookback === Infinity ? candles.length : lookback;
  if (size < 2 || candles.length < size) return null;
  const lastIndex = candles.length - 1;
  const high = candles[lastIndex]!.high;
  for (let i = candles.length - size; i < lastIndex; i++) {
    if (candles[i]!.high >= high) return null;
  }
  return lastIndex;
}
