import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateCandles, merge15mTo30m } from '../../src/indicators/merge.js';
import { candle } from '../helpers.js';

const M15 = 15 * 60 * 1000;

test('合成 OHLCV，丢弃奇数尾根，且不修改输入', () => {
  const input = [candle(0, 11, { open: 10, high: 15, low: 8, volume: 20 }),
    candle(M15, 13, { open: 11, high: 14, low: 7, volume: 30 }), candle(2 * M15)];
  const before = structuredClone(input);
  assert.deepEqual(merge15mTo30m(input), [
    { openTime: 0, open: 10, close: 13, high: 15, low: 7, volume: 50 },
  ]);
  assert.deepEqual(input, before);
});

test('空数组、单根、未对齐时间戳或不完整桶不合成', () => {
  assert.deepEqual(merge15mTo30m([]), []);
  assert.deepEqual(merge15mTo30m([candle(0)]), []);
  assert.deepEqual(merge15mTo30m([candle(1), candle(M15 + 1)]), []);
  assert.deepEqual(merge15mTo30m([candle(M15), candle(2 * M15)]), []);
  assert.deepEqual(merge15mTo30m([candle(0), candle(3 * M15)]), []);
});

test('乱序、重复时间戳取最后版本，中间缺失不影响后续完整桶', () => {
  const result = merge15mTo30m([candle(5 * M15), candle(M15), candle(4 * M15),
    candle(0), candle(M15, 12), candle(2 * M15)]);
  assert.deepEqual(result.map((bar) => [bar.openTime, bar.close, bar.volume]), [
    [0, 12, 200], [4 * M15, 10, 200],
  ]);
});

test('aggregateCandles 合成 1h/4h，残缺桶整桶丢弃', () => {
  const FIFTEEN = 15 * 60 * 1000;
  const base = 4 * 60 * 60 * 1000; // 对齐到 4h 边界
  // 16 根 15m = 1 根 4h
  const full = Array.from({ length: 16 }, (_, i) =>
    candle(base + i * FIFTEEN, 10 + i, { high: 100 + i, low: 1 + i, volume: 2 }));
  const [h4] = aggregateCandles(full, FIFTEEN, 4 * 60 * 60 * 1000);
  assert.equal(h4!.openTime, base);
  assert.equal(h4!.open, full[0]!.open);
  assert.equal(h4!.close, full[15]!.close);
  assert.equal(h4!.high, 115);
  assert.equal(h4!.low, 1);
  assert.equal(h4!.volume, 32);

  // 1h：4 根一桶
  assert.equal(aggregateCandles(full, FIFTEEN, 60 * 60 * 1000).length, 4);

  // 缺一根就整桶丢弃 —— 半个桶算出的 high/low 会让 A3 创新高判定失真
  assert.equal(aggregateCandles(full.slice(0, 15), FIFTEEN, 4 * 60 * 60 * 1000).length, 0);
  // 中间缺失同样不得跨桶拼接
  const holed = [...full.slice(0, 8), ...full.slice(9)];
  assert.equal(aggregateCandles(holed, FIFTEEN, 4 * 60 * 60 * 1000).length, 0);

  // 非法周期比例
  assert.deepEqual(aggregateCandles(full, FIFTEEN, FIFTEEN), []);
  assert.deepEqual(aggregateCandles(full, 4 * FIFTEEN, FIFTEEN), []);
  assert.deepEqual(aggregateCandles([], FIFTEEN, 60 * 60 * 1000), []);
});
