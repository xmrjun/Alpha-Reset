import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadStrategy } from '../../src/config/strategy.js';
import { evaluate, type RuleInput } from '../../src/rules/evaluate.js';
import { emptyBounds } from '../../src/indicators/observation-rps.js';
import { emptyScores, HOUR_MS, PERIOD_MS } from '../../src/market.js';
import { SAMPLE_STRATEGY, candle, poolItem } from '../helpers.js';

function input(): RuleInput {
  const now = 1000 * 24 * HOUR_MS;
  const series = (ms: number) => Array.from({ length: 60 }, (_, i) => candle(now - (60 - i) * ms,
    100 - i, { open: 101 - i, high: 102 - i, low: 99 - i }));
  return { ca: 'a', now, cfg: loadStrategy(SAMPLE_STRATEGY), pool: poolItem('a'),
    candles30m: series(PERIOD_MS['30m']), candles60m: series(PERIOD_MS['60m']), candles4h: series(PERIOD_MS['4h']),
    rpsScores: { ...emptyScores(), r16: 90 }, listedAt: now - 10 * HOUR_MS,
    moments: [1, 2, 3, 4, 5, 6].map((moment) => ({ moment: moment as 1 | 2 | 3 | 4 | 5 | 6,
      barTime: now - 60 * PERIOD_MS[moment <= 2 ? '30m' : moment <= 4 ? '60m' : '4h'], price: 102 })) };
}

test('A6 通过后，历史时刻支持跨轮回调，六种回调与补充标签可同时命中', () => {
  const value = input();
  const before = structuredClone(value);
  const result = evaluate(value);
  assert.equal(result.passed, true);
  assert.deepEqual(result.reasons, { a1: true, a2: true, a3: true, a4: true });
  assert.equal(result.tags.length, 12);
  assert.ok(result.tags.includes('30m_ath_pullback'));
  assert.ok(result.tags.includes('4h_8d_high_pullback'));
  assert.deepEqual(result.newMoments, []);
  assert.deepEqual(value, before);
});

test('A1 严格超过阈值；未知、未来上市时间均跳过', () => {
  const value = input();
  for (const listedAt of [null, value.now, value.now + 1, value.now - 4 * HOUR_MS]) {
    const result = evaluate({ ...value, listedAt });
    assert.equal(result.reasons.a1, false);
    assert.equal(result.passed, false);
    assert.deepEqual(result.tags, []);
  }
  assert.equal(evaluate({ ...value, listedAt: value.now - 4 * HOUR_MS - 1 }).passed, true);
});

test('A2 市值与流动性为严格区间，空值不得默认通过', () => {
  for (const overrides of [{ marketCap: 50_000 }, { marketCap: 40_000_000 },
    { marketCap: null }, { liquidity: 30_000 }, { liquidity: null }]) {
    const value = input();
    value.pool = { ...value.pool, ...overrides };
    assert.equal(evaluate(value).reasons.a2, false);
    assert.deepEqual(evaluate(value).tags, []);
  }
});

test('A3 没有新高且无历史时刻时失败，未来时刻不能参与', () => {
  const value = input();
  assert.equal(evaluate({ ...value, moments: [] }).reasons.a3, false);
  assert.equal(evaluate({ ...value, moments: [{ moment: 1, barTime: value.now + 1, price: 100 }] }).reasons.a3, false);
  assert.equal(evaluate({ ...value, now: value.now + 60_000,
    moments: [{ moment: 1, barTime: value.now, price: 100 }] }).reasons.a3, false);
  for (const key of Object.keys(value.cfg.a3_breakout.enabled) as (keyof typeof value.cfg.a3_breakout.enabled)[]) {
    value.cfg.a3_breakout.enabled[key] = false;
  }
  assert.equal(evaluate(value).reasons.a3, false);
});

test('A4 五项 OR，等于阈值或缺失不通过', () => {
  const value = input();
  assert.equal(evaluate({ ...value, rpsScores: emptyScores() }).reasons.a4, false);
  assert.equal(evaluate({ ...value, rpsScores: { ...emptyScores(), r16: 80, r96: 85 } }).reasons.a4, false);
  assert.equal(evaluate({ ...value, rpsScores: { ...emptyScores(), r672: 86 } }).reasons.a4, true);
});

test('新高编号正确；新时刻覆盖旧时刻并重置等待，重放不重复记录', () => {
  const value = input();
  value.candles30m[value.candles30m.length - 1]!.high = 1000;
  const result = evaluate(value);
  assert.deepEqual(result.newMoments.map((moment) => moment.moment), [1, 2]);
  assert.equal(result.newMoments[0]!.barTime, value.now - PERIOD_MS['30m']);
  assert.equal(result.newMoments[0]!.price, 1000);
  assert.ok(!result.tags.includes('30m_ath_pullback'));
  assert.ok(result.tags.includes('60m_ath_pullback'));
  const again = evaluate({ ...value, moments: [...value.moments.filter((moment) => moment.moment > 2), ...result.newMoments] });
  assert.deepEqual(again.newMoments, []);
});

test('等待要求四根后续已收盘 K 线，而非仅经过四个时间格', () => {
  const value = input();
  const lastTime = value.candles30m.at(-1)!.openTime;
  value.moments = [{ moment: 1, barTime: lastTime - 3 * PERIOD_MS['30m'], price: 1000 }];
  assert.ok(!evaluate(value).tags.includes('30m_ath_pullback'));
  value.moments[0]!.barTime -= PERIOD_MS['30m'];
  assert.ok(evaluate(value).tags.includes('30m_ath_pullback'));
  value.candles30m = value.candles30m.slice(-2);
  assert.ok(!evaluate(value).tags.includes('30m_ath_pullback'));
});

test('未收盘 bar 不触发新高；陈旧周期和断档不产生指标提醒', () => {
  const value = input();
  value.candles30m.push(candle(value.now, 5000));
  assert.deepEqual(evaluate(value).newMoments, []);
  value.candles60m.pop();
  const result = evaluate(value);
  assert.ok(!result.tags.some((tag) => tag.includes('60m')));
  value.candles4h.splice(-3, 1);
  assert.ok(!evaluate(value).tags.some((tag) => tag.includes('4h')));
});

test('全部累积历史参与 ATH；窗口新高只使用完整有限窗口', () => {
  const value = input();
  value.moments = [];
  value.candles30m[0]!.high = 1000;
  value.candles30m.at(-1)!.high = 500;
  assert.deepEqual(evaluate(value).newMoments.map((moment) => moment.moment), [2]);
  value.candles30m = value.candles30m.slice(-47);
  assert.deepEqual(evaluate(value).newMoments.map((moment) => moment.moment), [1]);
});

test('阈值配置驱动 A1/A2/A4、等待、RSI、MA 和新高开关', () => {
  const value = input();
  value.cfg.a1_age.minHours = 11;
  assert.equal(evaluate(value).reasons.a1, false);
  value.cfg.a1_age.minHours = 4;
  value.cfg.a2_scale.marketCapMin = 200_000;
  assert.equal(evaluate(value).reasons.a2, false);
  value.cfg.a2_scale.marketCapMin = 50_000;
  value.cfg.a4_rps.periods.r16.threshold = 95;
  assert.equal(evaluate(value).reasons.a4, false);
  value.cfg.a4_rps.periods.r16.threshold = 80;
  value.cfg.pullback.minBarsSinceHigh = 100;
  value.cfg.supplementary.rsiBelow = 0;
  value.cfg.supplementary.volMaPeriod = 100;
  assert.deepEqual(evaluate(value).tags, []);
  value.cfg.indicators.rsiPeriod = 100;
  value.cfg.pullback.minBarsSinceHigh = 4;
  assert.deepEqual(evaluate(value).tags, []);
});

test('RSI 等于 60 可回调，等于 50 不加超卖标签；平盘不算下跌低量', () => {
  const value = input();
  value.cfg.indicators.rsiPeriod = 2;
  value.candles30m = [10, 13, 11].map((close, i) => candle(value.now - (3 - i) * PERIOD_MS['30m'], close));
  value.cfg.pullback.minBarsSinceHigh = 1;
  assert.ok(evaluate(value).tags.includes('30m_ath_pullback'));
  value.cfg.pullback.maxRsi = 59;
  assert.ok(!evaluate(value).tags.includes('30m_ath_pullback'));
  value.candles30m = value.candles30m.map((bar) => ({ ...bar, open: 10, high: 10, low: 10, close: 10 }));
  assert.ok(!evaluate(value).tags.includes('rsi_lt50_30m'));
  assert.ok(!evaluate(value).tags.includes('low_vol_30m'));
});

test('缺数只允许已证明下界通过A4，跨阈值范围与等号不能发信号', () => {
  const value = input();
  value.rpsScores = emptyScores();
  value.rpsBounds = { ...emptyBounds(), r96: { lower: 86, upper: 96, status: 'pass' } };
  assert.equal(evaluate(value).reasons.a4, true);
  assert.ok(evaluate(value).tags.length > 0);
  for (const bound of [
    { lower: 80, upper: 90, status: 'unknown' as const },
    { lower: 85, upper: 95, status: 'pass' as const },
    { lower: 95, upper: 90, status: 'pass' as const },
  ]) {
    value.rpsBounds.r96 = bound;
    assert.equal(evaluate(value).reasons.a4, false);
    assert.deepEqual(evaluate(value).tags, []);
  }
  value.rpsBounds.r96 = { lower: 86, upper: 96, status: 'pass' };
  value.cfg.a4_rps.periods.r96.threshold = 86;
  assert.equal(evaluate(value).reasons.a4, false, '仍须遵守当前配置的严格阈值');
});
