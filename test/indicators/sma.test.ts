import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sma } from '../../src/indicators/sma.js';

test('SMA 正确滑动且不修改输入', () => {
  const input = [1, 2, 3, 4, 5];
  assert.deepEqual(sma(input, 3), [2, 3, 4]);
  assert.deepEqual(input, [1, 2, 3, 4, 5]);
  assert.deepEqual(sma([5, 10], 1), [5, 10]);
  assert.deepEqual(sma(Array(39).fill(10), 39), [10]);
});

test('SMA 空数组、数据不足、零值和非法周期', () => {
  assert.deepEqual(sma([], 39), []);
  assert.deepEqual(sma([1, 2], 3), []);
  assert.deepEqual(sma([0, 0], 2), [0]);
  for (const period of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => sma([], period), RangeError);
  }
});
