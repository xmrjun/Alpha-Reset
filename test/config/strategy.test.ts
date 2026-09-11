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
