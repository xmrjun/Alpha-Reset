import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadStrategy, StrategyConfigError } from '../../src/config/strategy.js';
import { SAMPLE_STRATEGY } from '../helpers.js';

function withConfig(content: string, run: (filename: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'alpha-strategy-'));
  const filename = join(directory, 'strategy.json');
  try { writeFileSync(filename, content); run(filename); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('集中配置包含需求阈值，loader 递归忽略所有 $comment 前缀键', () => {
  const config = loadStrategy(SAMPLE_STRATEGY);
  assert.equal(config.a1_age.minHours, 4);
  assert.deepEqual(config.a2_scale, { marketCapMin: 50_000, marketCapMax: 40_000_000, liquidityMin: 30_000 });
  assert.equal(config.a3_breakout.lookbackBars, 48);
  assert.deepEqual(config.indicators, { rsiPeriod: 14 });
  assert.equal(config.supplementary.volMaPeriod, 39);
  assert.deepEqual(config.pullback, { minBarsSinceHigh: 4, maxRsi: 60 });
  assert.deepEqual(Object.values(config.a4_rps.periods).map((entry) => entry.bars), [16, 56, 96, 288, 672]);
  const input = { ...config, $commentTop: 'ignored', a1_age: { ...config.a1_age, $commentNested: { anything: true } } };
  withConfig(JSON.stringify(input), (filename) => assert.deepEqual(loadStrategy(filename), config));
});

test('自定义阈值从文件生效，不被实现里的默认常量覆盖', () => {
  const config = loadStrategy(SAMPLE_STRATEGY);
  config.a1_age.minHours = 8;
  config.indicators.rsiPeriod = 21;
  config.alerting.cooldownBars = 6;
  withConfig(JSON.stringify(config), (filename) => assert.deepEqual(loadStrategy(filename), config));
});

test('非法配置、缺少字段及拼写错误拒绝，错误不包含原始内容', () => {
  const config = loadStrategy(SAMPLE_STRATEGY);
  const invalid = [
    '{}', '{invalid-private-value', JSON.stringify({ ...config, typo: true }),
    JSON.stringify({ ...config, a3_breakout: { ...config.a3_breakout, lookbackBars: 1 } }),
    JSON.stringify({ ...config, a2_scale: { ...config.a2_scale, marketCapMax: 1 } }),
    JSON.stringify({ ...config, quota: { ...config.quota, haltAtPercent: 50 } }),
    JSON.stringify({ ...config, indicators: { rsiPeriod: 1.5 } }),
    JSON.stringify({ ...config, a4_rps: { ...config.a4_rps, periods: {
      ...config.a4_rps.periods, r16: { bars: 16, hours: 8, threshold: 80 },
    } } }),
  ];
  for (const content of invalid) {
    withConfig(content, (filename) => assert.throws(() => loadStrategy(filename), (error: unknown) => {
      assert.ok(error instanceof StrategyConfigError);
      assert.doesNotMatch(error.message, /invalid-private-value/);
      return true;
    }));
  }
});

test('Gecko全量模式不再套用二娃每CA K线预算，名单刷新与评分频率独立', () => {
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  cfg.pool.maxCandidates = null;
  cfg.pool.refreshMinutes = 5;
  cfg.schedule.mainLoopMinutes = 30;
  withConfig(JSON.stringify(cfg), filename => {
    const loaded = loadStrategy(filename);
    assert.equal(loaded.pool.maxCandidates, null);
    assert.equal(loaded.pool.refreshMinutes, 5);
    assert.equal(loaded.schedule.mainLoopMinutes, 30);
  });
  cfg.pool.maxCandidates = 1000;
  withConfig(JSON.stringify(cfg), filename => assert.equal(loadStrategy(filename).pool.maxCandidates, 1000));
  for (const invalid of [0, -1, 1.5]) {
    withConfig(JSON.stringify({...cfg, pool:{...cfg.pool, refreshMinutes:invalid}}),filename=>assert.throws(()=>loadStrategy(filename),StrategyConfigError));
  }
});

test('GMGN独立预算与预热配置向后兼容，错误链或无效限额不能启用', () => {
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  const legacy = structuredClone(cfg) as typeof cfg & { kline: { gmgn?: typeof cfg.kline.gmgn } };
  const raw = JSON.parse(JSON.stringify(legacy)) as { kline: Record<string, unknown> };
  delete raw.kline.gmgn;
  withConfig(JSON.stringify(raw), filename => {
    const value = loadStrategy(filename);
    assert.equal(value.kline.gmgn.enabled, false);
    assert.equal(value.kline.gmgn.requestsPerMinute, 30);
    assert.equal(value.kline.requestsPerMinute, cfg.kline.requestsPerMinute);
    assert.equal(value.pool.maxCandidates, null);
  });
  for (const invalid of [
    { enabled: true, chains: [] }, { chains: ['sol', 'sol'] }, { chains: ['unknown'] },
    { requestsPerMinute: 0 }, { requestsPerMinute: 61 }, { requestsPerMinute: 1.5 },
    { refreshMinutes: 0 }, { warmupAssets: 0 }, { warmupAssets: 101 },
  ]) {
    withConfig(JSON.stringify({ ...cfg, kline: { ...cfg.kline, gmgn: { ...cfg.kline.gmgn, ...invalid } } }),
      filename => assert.throws(() => loadStrategy(filename), StrategyConfigError));
  }
});

test('正式T采用60分钟，共享迟到修订间隔3分钟，旧配置缺省revisionMinutes仍兼容', () => {
  const cfg = loadStrategy(SAMPLE_STRATEGY);
  assert.equal(cfg.schedule.mainLoopMinutes, 60);
  assert.equal(cfg.schedule.revisionMinutes, 3);
  const legacy = JSON.parse(JSON.stringify(cfg)) as { schedule: Record<string, unknown> };
  delete legacy.schedule.revisionMinutes;
  withConfig(JSON.stringify(legacy), (filename) => assert.equal(loadStrategy(filename).schedule.revisionMinutes, 3));
  for (const invalid of [0, -1, 1.5, '3', null]) {
    withConfig(JSON.stringify({ ...cfg, schedule: { ...cfg.schedule, revisionMinutes: invalid } }),
      (filename) => assert.throws(() => loadStrategy(filename), StrategyConfigError));
  }
  withConfig(JSON.stringify({ ...cfg, schedule: { ...cfg.schedule, revisionMinutes: 5 } }),
    (filename) => assert.equal(loadStrategy(filename).schedule.revisionMinutes, 5));
});
