import type { Candle } from '../types.js';

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const THIRTY_MINUTES = 2 * FIFTEEN_MINUTES;

/** 按半小时边界配对；缺失、未对齐的 bar 不可跨桶拼接。 */
export function merge15mTo30m(candles: Candle[]): Candle[] {
  return aggregateCandles(candles, FIFTEEN_MINUTES, THIRTY_MINUTES);
}

/**
 * 把低周期 K 线聚合成高周期。
 *
 * 只从 GeckoTerminal 拉 15m 一个周期，30m/1h/4h 全部由此本地合成 ——
 * 每个 CA 一次请求即可覆盖所有周期。
 *
 * 规则与 30m 合成一致，且同样**不容忍残缺**：
 * 一个高周期桶必须集齐全部低周期 bar 才产出，否则丢弃。
 * 这很重要 —— 用半个桶算出的 high/low 会让 A3 的创新高判定失真。
 */
export function aggregateCandles(candles: Candle[], fromMs: number, toMs: number): Candle[] {
  if (!Number.isInteger(toMs / fromMs) || toMs <= fromMs) return [];
  const perBucket = toMs / fromMs;
  const byTime = new Map(candles.map((candle) => [candle.openTime, candle]));
  const result: Candle[] = [];

  for (const time of [...byTime.keys()].sort((a, b) => a - b)) {
    if (time % toMs !== 0) continue;
    const parts: Candle[] = [];
    for (let i = 0; i < perBucket; i++) {
      const part = byTime.get(time + i * fromMs);
      if (!part) break;
      parts.push(part);
    }
    if (parts.length !== perBucket) continue;
    result.push({
      openTime: time,
      open: parts[0]!.open,
      close: parts[parts.length - 1]!.close,
      high: Math.max(...parts.map((bar) => bar.high)),
      low: Math.min(...parts.map((bar) => bar.low)),
      volume: parts.reduce((sum, bar) => sum + bar.volume, 0),
    });
  }
  return result;
}
