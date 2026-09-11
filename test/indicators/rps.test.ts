import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rps } from '../../src/indicators/rps.js';

test('按一基排名公式计分，负涨幅也参与，不修改入参', () => {
  const input = new Map([['c', -10], ['a', 30], ['b', 20], ['d', -20]]);
  const before = [...input];
  assert.deepEqual([...rps(input)], [['a', 75], ['b', 50], ['c', 25], ['d', 0]]);
  assert.deepEqual([...input], before);
});

test('空池与单元素池；公式规定单元素得 0 分', () => {
  assert.deepEqual(rps(new Map()), new Map());
  assert.equal(rps(new Map([['a', 10]])).get('a'), 0);
});

test('同涨幅同名次，后续使用竞争排名', () => {
  assert.deepEqual([...rps(new Map([['a', 10], ['b', 10], ['c', 5], ['d', 1]])).values()],
    [75, 75, 25, 0]);
  assert.deepEqual([...rps(new Map([['a', 1], ['b', 1], ['c', 1], ['d', 1]])).values()],
    [75, 75, 75, 75]);
});

test('缺失或非有限涨幅剔除，不污染排名分母', () => {
  const input = new Map<string, unknown>([['young', null], ['bad', NaN], ['infinite', Infinity],
    ['a', 5], ['b', 0]]);
  assert.deepEqual([...rps(input as Map<string, number>)], [['a', 50], ['b', 0]]);
});
