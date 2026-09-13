import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadStrategy } from '../../src/config/strategy.js';
import { selectObservationPool, PoolSelectionError } from '../../src/pool/select.js';
import { SAMPLE_STRATEGY, boardPoolItem } from '../helpers.js';

test('同CA不同链不可静默合并，但平台链别名可以归一', () => {
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  const groups = [
    { groupName: 'a', items: [boardPoolItem('0xabc', { chain: 'ethereum', totalMentions: 3 })] },
    { groupName: 'b', items: [boardPoolItem('0xabc', { chain: 'base', totalMentions: 2 })] },
  ];
  assert.throws(() => selectObservationPool(groups, cfg),
    (error: unknown) => error instanceof PoolSelectionError && error.code === 'POOL_CHAIN_CONFLICT');
  groups[1]!.items[0]!.chain = 'eth';
  const selected = selectObservationPool(groups, cfg);
  assert.equal(selected.items.length, 1);
  assert.equal(selected.items[0]!.totalMentions, 3);
  assert.equal(selected.items[0]!.groupName, 'a、b');
});

test('同一CA新提及缺少链名时保留先前已知网络', () => {
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  const selected = selectObservationPool([
    { groupName: 'a', items: [boardPoolItem('a', { chain: 'ethereum', latestMentionTime: 1 })] },
    { groupName: 'b', items: [boardPoolItem('a', { chain: null, latestMentionTime: 2 })] },
  ], cfg);
  assert.equal(selected.items[0]!.chain, 'ethereum');
  assert.equal(selected.items[0]!.latestMentionTime, 2);
});

test('全量模式纳入超过132个CA，低提及新增地址也进入池；三个群仍规范去重', () => {
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  cfg.pool.maxCandidates = null;
  const items = Array.from({length: 280}, (_, i) => boardPoolItem('asset-' + i, { totalMentions: 280 - i }));
  const selected = selectObservationPool([
    {groupName: 'a', items: items.slice(0, 150)},
    {groupName: 'b', items: items.slice(130, 260)},
    {groupName: 'c', items: [...items.slice(250), boardPoolItem('new-low-mention', {totalMentions: 0})]},
  ], cfg);
  assert.equal(selected.sourceCount, 281);
  assert.equal(selected.items.length, 281);
  assert.equal(selected.items.at(-1)!.ca, 'new-low-mention');
  assert.equal(selected.items.find(x => x.ca === 'asset-135')!.groupName, 'a、b');
  assert.equal(selected.sourceLimited, false);
  cfg.pool.maxCandidates = 2;
  assert.equal(selectObservationPool([{groupName:'a',items}],cfg).items.length, 2, '显式Top N兼容配置仍有效');
});

test('全量模式遇上游每群200上限如实标识截断，不把数量已满误当完整来源', () => {
  const cfg = loadStrategy(SAMPLE_STRATEGY); cfg.pool.maxCandidates = null;
  const selected = selectObservationPool([{groupName:'a', items:Array.from({length:200},(_,i)=>boardPoolItem('asset-'+i))}],cfg);
  assert.equal(selected.items.length, 200);
  assert.equal(selected.sourceLimited, true);
});
