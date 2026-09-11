import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectHigh } from '../../src/indicators/breakout.js';
import { candle } from '../helpers.js';

const bars = (highs: number[]) => highs.map((high, i) => candle(i, 1, { high }));

test('按 high 检测；有限窗口包括当前根，历史高点使用全部输入', () => {
  const input = bars([100, 2, 3, 4]);
  const before = structuredClone(input);
  assert.equal(detectHigh(input, 3), 3);
  assert.equal(detectHigh(input, Infinity), null);
  assert.equal(detectHigh(bars([1, 2, 3]), Infinity), 2);
  assert.deepEqual(input, before);
});

test('空数组、单根、并列最高、非最新高点、窗口不足不产生时刻', () => {
  assert.equal(detectHigh([], Infinity), null);
  assert.equal(detectHigh(bars([10]), Infinity), null);
  assert.equal(detectHigh(bars([1, 3, 3]), 3), null);
  assert.equal(detectHigh(bars([1, 3, 2]), Infinity), null);
  assert.equal(detectHigh(bars([1, 2, 3]), 48), null);
  assert.equal(detectHigh(bars([1, 2]), 1), null);
});

test('48 bar 窗口必须完整', () => {
  const input = bars(Array.from({ length: 48 }, (_, i) => i + 1));
  assert.equal(detectHigh(input.slice(1), 48), null);
  assert.equal(detectHigh(input, 48), 47);
});

test('非法 lookback 拒绝', () => {
  for (const lookback of [0, -1, 1.5, NaN, -Infinity]) {
    assert.throws(() => detectHigh([], lookback), RangeError);
  }
});
