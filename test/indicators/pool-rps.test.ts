import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadStrategy } from '../../src/config/strategy.js';
import { calculatePoolRps, type RpsMember } from '../../src/indicators/pool-rps.js';
import { INTERVAL_MS, HOUR_MS } from '../../src/market.js';
import { SAMPLE_STRATEGY, candle } from '../helpers.js';

const now = 100 * 24 * HOUR_MS;
function member(ca: string, change: number): RpsMember {
  return { ca, listedAt: 0, candles60m: [], candles15m: [
    candle(now - 17 * INTERVAL_MS['15m'], 100), candle(now - INTERVAL_MS['15m'], 100 + change),
  ] };
}

test('RPS 按完整观察池排名，不接收 A1/A2 过滤参数', () => {
  const members = [member('a', 20), member('b', 40), member('c', -10), member('d', 10)];
  const scores = calculatePoolRps(members, now, loadStrategy(SAMPLE_STRATEGY));
  assert.deepEqual([...scores].map(([ca, score]) => [ca, score.r16]), [['a', 50], ['b', 75], ['c', 0], ['d', 25]]);
  assert.equal(scores.get('a')!.r96, null);
});

test('空池、未知上市、存续不足、缺失端点及零起价不进入分母', () => {
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  assert.equal(calculatePoolRps([], now, cfg).size, 0);
  const young = member('young', 50); young.listedAt = now - HOUR_MS;
  const unknown = member('unknown', 20); unknown.listedAt = null;
  const zero = member('zero', 10); zero.candles15m[0]!.close = 0;
  const missing = member('missing', 50); missing.candles15m.shift();
  const scores = calculatePoolRps([member('a', 10), young, unknown, zero, missing], now, cfg);
  assert.equal(scores.get('a')!.r16, 0);
  for (const ca of ['young', 'unknown', 'zero', 'missing']) assert.equal(scores.get(ca)!.r16, null);
});

test('小时线可补精确端点，不能拿邻近小时近似半小时端点', () => {
  const value = member('a', 10);
  value.candles60m = [candle(now - 73 * HOUR_MS, 50)];
  assert.equal(calculatePoolRps([value], now, loadStrategy(SAMPLE_STRATEGY)).get('a')!.r288, 0);
  value.candles15m = [candle(now + HOUR_MS / 4, 110)];
  assert.equal(calculatePoolRps([value], now + HOUR_MS / 2, loadStrategy(SAMPLE_STRATEGY)).get('a')!.r288, null);
});

test('配置变更窗口、忽略未收盘与陈旧当前价格，输入不变', () => {
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  const value = member('a', 10);
  const before = structuredClone(value);
  assert.equal(calculatePoolRps([value], now, cfg).get('a')!.r16, 0);
  assert.deepEqual(value, before);
  cfg.a4_rps.periods.r16.bars = 8;
  assert.equal(calculatePoolRps([value], now, cfg).get('a')!.r16, null);
  assert.equal(calculatePoolRps([value], now + INTERVAL_MS['15m'], loadStrategy(SAMPLE_STRATEGY)).get('a')!.r16, null);
});
