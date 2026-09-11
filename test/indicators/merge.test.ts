import assert from 'node:assert/strict';
import { test } from 'node:test';
import { merge15mTo30m } from '../../src/indicators/merge.js';
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
