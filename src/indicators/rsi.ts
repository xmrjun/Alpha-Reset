import type { Candle } from '../types.js';

/** Wilder RSI；首项对应输入的 period 索引，全平价格约定为中性 50。 */
export function rsi(candles: Candle[], period = 14): number[] {
  if (!Number.isSafeInteger(period) || period < 1) {
    throw new RangeError('period 必须是正整数');
  }
  if (candles.length <= period) return [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    gain += Math.max(change, 0) / period;
    loss += Math.max(-change, 0) / period;
  }

  const value = () => loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  const result = [value()];
  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    result.push(value());
  }
  return result;
}
