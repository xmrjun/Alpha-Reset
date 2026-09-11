import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rsi } from '../../src/indicators/rsi.js';
import { candle } from '../helpers.js';

const bars = (values: number[]) => values.map((close, i) => candle(i, close));

test('RSI 默认 14，需要 15 个收盘价才产生首值', () => {
  assert.deepEqual(rsi([]), []);
  assert.deepEqual(rsi(bars([1, 2, 3])), []);
  assert.deepEqual(rsi(bars(Array(14).fill(10))), []);
  assert.deepEqual(rsi(bars(Array(15).fill(10))), [50]);
});

test('RSI 全涨、全跌、全平与平价变化', () => {
  assert.deepEqual(rsi(bars([1, 2, 3, 4, 5]), 2), [100, 100, 100]);
  assert.deepEqual(rsi(bars([5, 4, 3, 2, 1]), 2), [0, 0, 0]);
  assert.deepEqual(rsi(bars([3, 3, 3, 3]), 2), [50, 50]);
  assert.deepEqual(rsi(bars([1, 2, 2, 2]), 2), [100, 100]);
});

test('使用 Wilder 递推而非每窗口重算简单均值', () => {
  const input = bars([10, 12, 11, 14, 13]);
  const before = structuredClone(input);
  const result = rsi(input, 3);
  assert.equal(result.length, 2);
  assert.ok(Math.abs(result[0]! - 83.33333333333333) < 1e-10);
  assert.ok(Math.abs(result[1]! - 66.66666666666667) < 1e-10);
  assert.deepEqual(input, before);
});

test('RSI 非法周期拒绝，周期 1 可用', () => {
  for (const period of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => rsi([], period), RangeError);
  }
  assert.deepEqual(rsi(bars([1, 2, 1]), 1), [100, 0]);
});
