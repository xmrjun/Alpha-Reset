import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadStrategy } from '../../src/config/strategy.js';
import { calculateObservationRps, emptyBounds, type ObservationRpsMember } from '../../src/indicators/observation-rps.js';
import { rps } from '../../src/indicators/rps.js';
import { HOUR_MS, INTERVAL_MS, RPS_KEYS, emptyScores } from '../../src/market.js';
import { SAMPLE_STRATEGY, candle } from '../helpers.js';

const NOW = 100 * 24 * HOUR_MS;
const STEP = INTERVAL_MS['15m'];
const defaults = loadStrategy(SAMPLE_STRATEGY);
const config = () => structuredClone(defaults);
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10,
  `expected ${actual} to equal ${expected}`);

function member(ca: string, change = 0, baseline = NOW): ObservationRpsMember {
  return {
    ca, listedAt: 0, candles60m: [], liquidity: 50_000,
    candles15m: [
      ...RPS_KEYS.map((key) => candle(baseline - (defaults.a4_rps.periods[key].bars + 1) * STEP, 100)),
      candle(baseline - STEP, 100 + change),
    ],
    dexStatus: 'ok',
    dex: { pairAddress: 'pool', chainId: 'solana', priceUsd: 100 + change,
      marketCap: 100_000, liquidityUsd: 50_000, pairCreatedAt: 0,
      priceChange: { m5: null, h1: null, h6: null, h24: -change } },
  };
}

function missing(ca: string): ObservationRpsMember {
  return { ...member(ca), candles15m: [], candles60m: [] };
}

test('五档独立使用各自精确起点和同一收盘终点，保留竞争排名', () => {
  const a = member('a', 100);
  const b = member('b');
  const starts = [100, 400, 50, 200, 100];
  for (let i = 0; i < RPS_KEYS.length; i++) a.candles15m[i]!.close = starts[i]!;
  const result = calculateObservationRps([a, b], NOW, config());
  assert.deepEqual(result.scores.get('a'), { r16: 50, r56: 0, r96: 50, r288: 50, r672: 50 });
  assert.deepEqual(result.scores.get('b'), { r16: 0, r56: 50, r96: 0, r288: 50, r672: 0 });
  for (const key of RPS_KEYS) {
    assert.equal(result.coverage[key].source, 'kline');
    assert.equal(result.coverage[key].eligible, 2);
    assert.equal(result.coverage[key].available, 2);
    assert.equal(result.coverage[key].complete, true);
    const score = result.scores.get('a')![key]!;
    assert.deepEqual(result.bounds.get('a')![key], { lower: score, upper: score, status: 'exact' });
  }
});

test('RPS96 不采用 Dex h24，Dex 失败也不覆盖精确 K 线结果', () => {
  const a = member('a');
  const b = member('b', 10);
  a.dex!.priceChange.h24 = 99_999;
  b.dex!.priceChange.h24 = -99_999;
  let result = calculateObservationRps([a, b], NOW, config());
  assert.equal(result.scores.get('a')!.r96, 0);
  assert.equal(result.scores.get('b')!.r96, 50);
  a.dex = null;
  a.dexStatus = 'error';
  result = calculateObservationRps([a, b], NOW, config());
  assert.equal(result.scores.get('b')!.r96, 50);
  for (const value of [a, b]) {
    value.candles15m = value.candles15m.filter((bar) => bar.openTime !== NOW - 97 * STEP);
  }
  result = calculateObservationRps([a, b], NOW, config());
  assert.equal(result.scores.get('a')!.r96, null);
  assert.equal(result.scores.get('b')!.r96, null);
  assert.equal(result.coverage.r96.missingStart, 2);
});

test('小时线可补足精确收盘端点，存在 15m 同端点时以 15m 为准', () => {
  const a = member('a', 20);
  const b = member('b', 10);
  for (const value of [a, b]) {
    value.candles60m = value.candles15m.map((bar) => candle(bar.openTime + STEP - HOUR_MS, bar.close));
    value.candles15m = [];
  }
  let result = calculateObservationRps([a, b], NOW, config());
  for (const key of RPS_KEYS) assert.equal(result.scores.get('a')![key], 50);
  a.candles15m = [candle(NOW - STEP, 90)];
  result = calculateObservationRps([a, b], NOW, config());
  for (const key of RPS_KEYS) {
    assert.equal(result.scores.get('a')![key], 0);
    assert.equal(result.scores.get('b')![key], 50);
  }
});

test('半小时终点不能用邻近小时作起点，maxStaleBars 不放宽排名时点', () => {
  const cfg = config();
  cfg.a4_rps.maxStaleBars = 100;
  const baseline = NOW + 2 * STEP;
  const members = [member('a', 20), member('b', 10)];
  for (const value of members) {
    value.candles60m = value.candles15m.map((bar) => candle(bar.openTime + STEP - HOUR_MS, bar.close));
    value.candles15m = [candle(baseline - STEP, 120)];
  }
  let result = calculateObservationRps(members, baseline, cfg);
  for (const key of RPS_KEYS) {
    assert.equal(result.coverage[key].missingStart, 2);
    assert.equal(result.scores.get('a')![key], null);
  }
  result = calculateObservationRps([member('a', 20), member('b', 10)], NOW + STEP, cfg);
  assert.equal(result.coverage.r16.missingCurrent, 2);
  assert.equal(result.scores.get('a')!.r16, null);
});

test('已有端点刚收盘即可使用，未收盘、未来与不对齐的点都不能替代端点', () => {
  const members = [member('a', 20), member('b', 10)];
  members[1]!.candles15m.push(candle(NOW, 100_000), candle(NOW + STEP, 100_000),
    candle(NOW - STEP + 1, 100_000));
  let result = calculateObservationRps(members, NOW + 1, config());
  assert.equal(result.scores.get('a')!.r16, 50);
  members[1]!.candles15m = members[1]!.candles15m.filter((bar) => bar.openTime !== NOW - STEP);
  result = calculateObservationRps(members, NOW + 1, config());
  assert.equal(result.coverage.r16.available, 1);
  assert.equal(result.coverage.r16.missingCurrent, 1);
  assert.equal(result.scores.get('b')!.r16, null);
  assert.equal(result.bounds.get('b')!.r16, null);
});

test('起点或终点缺失分别计数，不能把缺失成员从适龄分母移除', () => {
  const cfg = config();
  cfg.a4_rps.minCoverage = 0.5;
  const noStart = member('no-start');
  noStart.candles15m = noStart.candles15m.filter((bar) => bar.openTime !== NOW - 17 * STEP);
  const noCurrent = member('no-current');
  noCurrent.candles15m = noCurrent.candles15m.filter((bar) => bar.openTime !== NOW - STEP);
  const result = calculateObservationRps([member('a', 20), member('b', 10), noStart, noCurrent], NOW, cfg);
  assert.deepEqual(result.coverage.r16, { eligible: 4, available: 2, complete: false, source: 'kline',
    unknownAge: 0, inactive: 0, illiquid: 0, ageConfirmedByHistory: 0, missingStart: 1, missingCurrent: 1, boundedPassCount: 0 });
  assert.deepEqual(result.bounds.get('a')!.r16, { lower: 25, upper: 75, status: 'fail' });
  assert.equal(result.scores.get('a')!.r16, null);
});

test('75% 覆盖不能把子集高分当成完整池通过，保留缺失排名的不确定性', () => {
  const cfg = config();
  assert.equal(cfg.a4_rps.minCoverage, 0.75);
  const known = Array.from({ length: 75 }, (_, index) => member(`known-${index}`, 100 - index));
  const unknown = Array.from({ length: 25 }, (_, index) => missing(`missing-${index}`));
  const result = calculateObservationRps([...known, ...unknown], NOW, cfg);
  const oldSubsetScore = rps(new Map(known.map((value, index) => [value.ca, 100 - index]))).get('known-9')!;
  assert.ok(oldSubsetScore > cfg.a4_rps.periods.r96.threshold, '旧子集口径会通过');
  assert.equal(result.scores.get('known-9')!.r96, null);
  const bound = result.bounds.get('known-9')!.r96!;
  near(bound.lower, 65);
  near(bound.upper, 90);
  assert.equal(bound.status, 'unknown');
  assert.equal(result.coverage.r96.eligible, 100);
  assert.equal(result.coverage.r96.available, 75);
  assert.equal(result.coverage.r96.complete, false);
  assert.equal(result.coverage.r96.boundedPassCount, 0);
});

test('缺数时只有最坏排名仍超过阈值的成员可通过，不伪造精确分数', () => {
  const members = [
    ...Array.from({ length: 95 }, (_, index) => member(`known-${index}`, 100 - index)),
    ...Array.from({ length: 5 }, (_, index) => missing(`missing-${index}`)),
  ];
  const result = calculateObservationRps(members, NOW, config());
  assert.deepEqual(result.bounds.get('known-0')!.r96, { lower: 94, upper: 99, status: 'pass' });
  assert.equal(result.scores.get('known-0')!.r96, null);
  assert.ok(result.coverage.r96.boundedPassCount > 0);
  assert.equal(result.bounds.get('missing-0')!.r96, null);
});

test('完整池并列使用竞争名次 1、1、3、4，分数和区间一致', () => {
  const result = calculateObservationRps([member('a', 20), member('b', 20), member('c', 10), member('d')], NOW, config());
  for (const key of RPS_KEYS) {
    assert.deepEqual(['a', 'b', 'c', 'd'].map((ca) => result.scores.get(ca)![key]), [75, 75, 25, 0]);
    assert.deepEqual(result.bounds.get('a')![key], { lower: 75, upper: 75, status: 'exact' });
    assert.deepEqual(result.bounds.get('b')![key], result.bounds.get('a')![key]);
  }
});

test('缺数并列也按竞争名次计算，下界等于阈值不通过，上界等于阈值可判失败', () => {
  const members = [member('a', 20), member('b', 20), member('c', 10), missing('d')];
  const cfg = config();
  cfg.a4_rps.periods.r16.threshold = 50;
  let result = calculateObservationRps(members, NOW, cfg);
  assert.deepEqual(result.bounds.get('a')!.r16, { lower: 50, upper: 75, status: 'unknown' });
  assert.deepEqual(result.bounds.get('b')!.r16, result.bounds.get('a')!.r16);
  assert.deepEqual(result.bounds.get('c')!.r16, { lower: 0, upper: 25, status: 'fail' });
  cfg.a4_rps.periods.r16.threshold = 49;
  result = calculateObservationRps(members, NOW, cfg);
  assert.equal(result.bounds.get('a')!.r16!.status, 'pass');
  assert.equal(result.coverage.r16.boundedPassCount, 2);
  cfg.a4_rps.periods.r16.threshold = 75;
  result = calculateObservationRps(members, NOW, cfg);
  assert.equal(result.bounds.get('a')!.r16!.status, 'fail');
});

test('minRanked 与 minCoverage 均从 cfg 读取，门槛不足时连区间也不发布', () => {
  const cfg = config();
  const members = [member('a', 20), member('b', 10), member('c'), missing('d')];
  cfg.a4_rps.minRanked = 4;
  let result = calculateObservationRps(members, NOW, cfg);
  assert.equal(result.bounds.get('a')!.r16, null);
  assert.equal(result.coverage.r16.available, 3);
  cfg.a4_rps.minRanked = 2;
  cfg.a4_rps.minCoverage = 0.8;
  result = calculateObservationRps(members, NOW, cfg);
  assert.equal(result.bounds.get('a')!.r16, null);
  cfg.a4_rps.minCoverage = 0.75;
  result = calculateObservationRps(members, NOW, cfg);
  assert.deepEqual(result.bounds.get('a')!.r16, { lower: 50, upper: 75, status: 'fail' });
});

test('没有更早历史证据时，Dex 上市不足仅从对应周期排除，恰好等于起点可参与', () => {
  const a = member('a', 20);
  const b = member('b', 10);
  a.listedAt = NOW - 16 * STEP;
  // 只保留四小时窗口的历史；不能给真正年轻的夹具塞入七天前价格。
  a.candles15m = a.candles15m.filter((bar) => bar.openTime + STEP >= a.listedAt!);
  let result = calculateObservationRps([a, b], NOW, config());
  assert.equal(result.coverage.r16.eligible, 2);
  assert.equal(result.scores.get('a')!.r16, 50);
  for (const key of RPS_KEYS.filter((key) => key !== 'r16')) {
    assert.equal(result.coverage[key].eligible, 1);
    assert.equal(result.scores.get('a')![key], null);
  }
  a.listedAt++;
  a.candles15m = a.candles15m.filter((bar) => bar.openTime + STEP >= a.listedAt!);
  result = calculateObservationRps([a, b], NOW, config());
  assert.equal(result.coverage.r16.eligible, 1);
  assert.equal(result.bounds.get('a')!.r16, null);
});

test('无历史证据时未知、无效或未来上市时间自身不排名，作为潜在适龄成员扩大区间', () => {
  for (const listedAt of [null, NaN, Infinity, NOW + 1]) {
    const cfg = config();
    cfg.a4_rps.minCoverage = 0.5;
    cfg.a4_rps.periods.r16.threshold = 40;
    const unknown = missing('unknown');
    unknown.candles15m = [candle(NOW - STEP, 100_099)];
    unknown.listedAt = listedAt;
    const result = calculateObservationRps([member('a', 20), member('b', 10), unknown], NOW, cfg);
    assert.equal(result.coverage.r16.eligible, 3);
    assert.equal(result.coverage.r16.unknownAge, 1);
    assert.equal(result.coverage.r16.available, 2);
    assert.equal(result.coverage.r16.complete, false);
    assert.deepEqual(result.scores.get('unknown'), emptyScores());
    assert.deepEqual(result.bounds.get('unknown'), emptyBounds());
    assert.equal(result.scores.get('a')!.r16, null);
    const bound = result.bounds.get('a')!.r16!;
    near(bound.lower, 100 / 3);
    near(bound.upper, 200 / 3);
    assert.equal(bound.status, 'unknown');
    // 未知成员实际年轻、适龄且强于目标、适龄且弱于目标，真实名次均被区间包住。
    for (const trueScore of [50, 100 / 3, 200 / 3]) {
      assert.ok(trueScore >= bound.lower - 1e-10 && trueScore <= bound.upper + 1e-10);
    }
  }
});

test('少量未知上市时间不阻断已被保守下界证明的通过，始终不产生精确分数', () => {
  const members = Array.from({ length: 100 }, (_, index) => member(`ca-${index}`, 100 - index));
  members[99]!.listedAt = null;
  members[99]!.candles15m = [candle(NOW - STEP, 101)];
  const result = calculateObservationRps(members, NOW, config());
  assert.equal(result.coverage.r96.unknownAge, 1);
  assert.equal(result.coverage.r96.eligible, 100);
  assert.equal(result.coverage.r96.available, 99);
  assert.deepEqual(result.bounds.get('ca-0')!.r96, { lower: 98, upper: 99, status: 'pass' });
  assert.equal(result.scores.get('ca-0')!.r96, null);
});

test('未知年龄仍计入覆盖率，不能通过移除未知成员凑满覆盖', () => {
  const cfg = config();
  const unknown = missing('unknown');
  unknown.listedAt = null;
  const result = calculateObservationRps([member('a', 20), member('b', 10), unknown], NOW, cfg);
  assert.equal(result.coverage.r16.eligible, 3);
  assert.equal(result.coverage.r16.available, 2);
  assert.equal(result.bounds.get('a')!.r16, null, '2/3 未达到 0.75');
});

test('零价、负价与非有限端点视为缺失，保留其适龄分母', () => {
  const cfg = config();
  cfg.a4_rps.minCoverage = 0.5;
  for (const price of [0, -1, Infinity, NaN]) {
    const bad = member('bad');
    bad.candles15m[0]!.close = price;
    const result = calculateObservationRps([member('a', 20), member('b', 10), bad], NOW, cfg);
    assert.equal(result.coverage.r16.eligible, 3);
    assert.equal(result.coverage.r16.available, 2);
    assert.equal(result.coverage.r16.missingStart, 1);
    assert.equal(result.bounds.get('bad')!.r16, null);
  }
});

test('窗口长度来自配置，输入数组不变，空池与单成员不产生可触发排名', () => {
  const cfg = config();
  const members = [member('a', 20), member('b', 10)];
  const before = structuredClone(members);
  calculateObservationRps(members, NOW, cfg);
  assert.deepEqual(members, before);
  cfg.a4_rps.periods.r16.bars = 8;
  cfg.a4_rps.periods.r16.hours = 2;
  let result = calculateObservationRps(members, NOW, cfg);
  assert.equal(result.coverage.r16.missingStart, 2);
  assert.equal(result.scores.get('a')!.r16, null);
  for (const value of members) value.candles15m.push(candle(NOW - 9 * STEP, 100));
  result = calculateObservationRps(members, NOW, cfg);
  assert.equal(result.scores.get('a')!.r16, 50);
  result = calculateObservationRps([], NOW, cfg);
  assert.equal(result.scores.size, 0);
  assert.equal(result.bounds.size, 0);
  assert.equal(result.coverage.r16.eligible, 0);
  assert.equal(result.coverage.r16.complete, false);
  result = calculateObservationRps([member('alone')], NOW, config());
  assert.deepEqual(result.scores.get('alone'), emptyScores());
  assert.deepEqual(result.bounds.get('alone'), emptyBounds());
});

test('Dex 上市时间为空但五档价格端点齐全时，由历史证明适龄并给出精确 RPS', () => {
  const a = member('a', 20);
  const b = member('b', 10);
  a.listedAt = null;
  b.listedAt = null;
  a.dex = null;
  a.dexStatus = 'error';
  b.dex!.pairCreatedAt = null;
  const members = [a, b];
  const before = structuredClone(members);
  const result = calculateObservationRps(members, NOW, config());
  for (const key of RPS_KEYS) {
    assert.equal(result.coverage[key].ageConfirmedByHistory, 2);
    assert.equal(result.coverage[key].unknownAge, 0);
    assert.equal(result.coverage[key].eligible, 2);
    assert.equal(result.coverage[key].available, 2);
    assert.equal(result.coverage[key].complete, true);
    assert.equal(result.scores.get('a')![key], 50);
    assert.equal(result.scores.get('b')![key], 0);
    assert.deepEqual(result.bounds.get('a')![key], { lower: 50, upper: 50, status: 'exact' });
  }
  assert.deepEqual(members, before, 'RPS 历史证据不修改 A1 上市时间或其他输入');
});

test('Dex 日期晚于可信历史或日期无效时，历史存续证据优先，不伪造上市日', () => {
  for (const listedAt of [NOW - STEP, NOW + STEP, Infinity, NaN]) {
    const a = member('a', 20);
    a.listedAt = listedAt;
    const members = [a, member('b', 10)];
    const before = structuredClone(members);
    const result = calculateObservationRps(members, NOW, config());
    for (const key of RPS_KEYS) {
      assert.equal(result.coverage[key].ageConfirmedByHistory, 1);
      assert.equal(result.coverage[key].unknownAge, 0);
      assert.equal(result.coverage[key].eligible, 2);
      assert.equal(result.coverage[key].complete, true);
      assert.equal(result.scores.get('a')![key], 50);
    }
    assert.deepEqual(members, before);
  }
});

test('target 之前存在历史可证明适龄，但缺失 target 精确价格仍须保留缺数区间', () => {
  const cfg = config();
  cfg.a4_rps.minCoverage = 0.5;
  const target = NOW - cfg.a4_rps.periods.r16.bars * STEP;
  const old = missing('old');
  old.listedAt = null;
  old.candles15m = [candle(target - 2 * STEP, 100), candle(NOW - STEP, 150)];
  const result = calculateObservationRps([member('a', 20), member('b', 10), old], NOW, cfg);
  assert.equal(result.coverage.r16.ageConfirmedByHistory, 1);
  assert.equal(result.coverage.r16.unknownAge, 0);
  assert.equal(result.coverage.r16.eligible, 3);
  assert.equal(result.coverage.r16.available, 2);
  assert.equal(result.coverage.r16.missingStart, 1);
  assert.equal(result.coverage.r16.complete, false);
  assert.equal(result.scores.get('old')!.r16, null);
  assert.equal(result.bounds.get('old')!.r16, null);
  const bound = result.bounds.get('a')!.r16!;
  near(bound.lower, 100 / 3);
  near(bound.upper, 200 / 3);
  assert.equal(bound.status, 'fail');
});

test('历史存续证据按窗口分别判断，四小时历史不能证明更长窗口适龄', () => {
  const a = missing('a');
  a.listedAt = null;
  a.candles15m = [candle(NOW - 17 * STEP, 100), candle(NOW - STEP, 120)];
  const result = calculateObservationRps([a, member('b', 10)], NOW, config());
  assert.equal(result.coverage.r16.ageConfirmedByHistory, 1);
  assert.equal(result.coverage.r16.unknownAge, 0);
  assert.equal(result.coverage.r16.complete, true);
  assert.equal(result.scores.get('a')!.r16, 50);
  for (const key of RPS_KEYS.filter((key) => key !== 'r16')) {
    assert.equal(result.coverage[key].ageConfirmedByHistory, 0);
    assert.equal(result.coverage[key].unknownAge, 1);
    assert.equal(result.coverage[key].eligible, 2, '未知成员不能从潜在分母删除');
    assert.equal(result.coverage[key].available, 1);
    assert.equal(result.coverage[key].complete, false);
    assert.equal(result.scores.get('a')![key], null);
    assert.equal(result.bounds.get('b')![key], null);
  }
});

test('年龄证据使用收盘时刻：target 开始的 15m 或小时 bar 不能证明 target 已有价格', () => {
  const cfg = config();
  cfg.a4_rps.minCoverage = 0.5;
  const target = NOW - cfg.a4_rps.periods.r16.bars * STEP;
  for (const interval of ['15m', '1h'] as const) {
    const unknown = missing('unknown');
    unknown.listedAt = null;
    if (interval === '15m') unknown.candles15m = [candle(target, 100), candle(NOW - STEP, 120)];
    else {
      unknown.candles60m = [candle(target, 100)];
      unknown.candles15m = [candle(NOW - STEP, 120)];
    }
    const result = calculateObservationRps([member('a', 20), member('b', 10), unknown], NOW, cfg);
    assert.equal(result.coverage.r16.ageConfirmedByHistory, 0);
    assert.equal(result.coverage.r16.unknownAge, 1);
    assert.equal(result.coverage.r16.eligible, 3);
    assert.equal(result.coverage.r16.available, 2);
    assert.equal(result.bounds.get('unknown')!.r16, null);
  }
});

test('未收盘小时 bar 和未来 bar 不能成为历史年龄证据', () => {
  const cfg = config();
  cfg.a4_rps.periods.r16.bars = 1;
  cfg.a4_rps.periods.r16.hours = 0.25;
  cfg.a4_rps.minCoverage = 0.5;
  const baseline = NOW + STEP;
  const unknown = missing('unknown');
  unknown.listedAt = null;
  // 本窗口 target=NOW；小时 bar 虽已开盘，仍在途，不能据此证明 target 有收盘价。
  unknown.candles60m = [candle(NOW, 100), candle(NOW + HOUR_MS, 120)];
  unknown.candles15m = [candle(NOW, 110), candle(baseline, 130), candle(baseline + STEP, 150)];
  const known = [member('a', 20, baseline), member('b', 10, baseline)];
  for (const value of known) value.candles15m.push(candle(NOW - STEP, 100));
  const result = calculateObservationRps([...known, unknown], baseline, cfg);
  assert.equal(result.coverage.r16.ageConfirmedByHistory, 0);
  assert.equal(result.coverage.r16.unknownAge, 1);
  assert.equal(result.coverage.r16.eligible, 3);
  assert.equal(result.coverage.r16.available, 2);
  assert.equal(result.bounds.get('unknown')!.r16, null);
});

test('小时线精确收盘也可证明年龄，零量平价证据有效，非正或非有限价格无效', () => {
  const cfg = config();
  cfg.a4_rps.minCoverage = 0.5;
  const target = NOW - cfg.a4_rps.periods.r16.bars * STEP;
  for (const price of [100, 0, -1, Infinity, NaN]) {
    const unknown = missing('unknown');
    unknown.listedAt = null;
    unknown.candles60m = [candle(target - HOUR_MS, price, { volume: 0 })];
    unknown.candles15m = [candle(NOW - STEP, 120)];
    const result = calculateObservationRps([member('a', 10), member('b'), unknown], NOW, cfg);
    assert.equal(result.coverage.r16.ageConfirmedByHistory, price === 100 ? 1 : 0);
    assert.equal(result.coverage.r16.unknownAge, price === 100 ? 0 : 1);
    assert.equal(result.coverage.r16.eligible, 3);
    assert.equal(result.coverage.r16.available, price === 100 ? 3 : 2);
    assert.equal(result.coverage.r16.complete, price === 100);
    if (price === 100) near(result.scores.get('unknown')!.r16!, 200 / 3);
    else assert.equal(result.scores.get('unknown')!.r16, null);
  }
});

test('覆盖不足仍能展示数学范围，但规则bounds和通过状态继续受配置门槛限制', () => {
  const cfg = config();
  cfg.a4_rps.minCoverage = 0.8;
  cfg.a4_rps.periods.r16.threshold = 25;
  const missing = member('missing', 0);
  missing.candles15m = []; missing.candles60m = [];
  const result = calculateObservationRps([member('a', 30), member('b', 20), member('c', 10), missing], NOW, cfg);
  assert.equal(result.coverage.r16.available, 3);
  assert.equal(result.coverage.r16.eligible, 4);
  assert.equal(result.coverage.r16.boundedPassCount, 0);
  assert.equal(result.scores.get('a')!.r16, null);
  assert.equal(result.bounds.get('a')!.r16, null);
  assert.deepEqual(result.displayBounds.get('a')!.r16, { lower: 50, upper: 75, status: 'unknown' });
  assert.equal(result.displayBounds.get('missing')!.r16, null);
});

test('最后收盘价早于失活阈值的成员移出分母，阈值内的稀疏成员仍保留', () => {
  const cfg = config();
  assert.equal(cfg.a4_rps.inactiveAfterBars, 16);
  // 最后一根落在 baseline-16 根（恰好等于阈值）仍算存活；再早一根即失活。
  const edge = member('edge');
  edge.candles15m = [candle(NOW - 700 * STEP, 100), candle(NOW - 17 * STEP, 100)];
  const dead = member('dead');
  dead.candles15m = [candle(NOW - 700 * STEP, 100), candle(NOW - 18 * STEP, 100)];
  const result = calculateObservationRps([member('a', 20), member('b', 10), edge, dead], NOW, cfg);
  assert.equal(result.coverage.r16.inactive, 1, '只有 dead 被剔除');
  assert.equal(result.coverage.r16.eligible, 3, 'edge 仍占分母');
  assert.equal(result.coverage.r16.available, 2);
  assert.equal(result.coverage.r16.missingCurrent, 1, 'edge 缺当前端点但不被剔除');
  assert.deepEqual(result.bounds.get('dead')!, emptyBounds(), '被剔除者自身不产生任何评分');
  assert.deepEqual(result.scores.get('dead')!, emptyScores());
});

test('剔除失活成员只会压低而非抬高存活成员的保守下界与分数', () => {
  const cfg = config();
  const alive = [member('a', 30), member('b', 20), member('c', 10)];
  const dead = Array.from({ length: 3 }, (_, index) => {
    const item = member(`dead-${index}`);
    item.candles15m = [candle(NOW - 700 * STEP, 100), candle(NOW - 40 * STEP, 100)];
    return item;
  });
  const withDead = calculateObservationRps([...alive, ...dead], NOW, cfg);
  const withoutDead = calculateObservationRps(alive, NOW, cfg);
  assert.equal(withDead.coverage.r16.inactive, 3);
  // 剔除后分母由 6 降到 3，第一名的精确分从 (1-1/6) 降到 (1-1/3)
  assert.deepEqual(withDead.coverage.r16.eligible, withoutDead.coverage.r16.eligible);
  assert.equal(withDead.coverage.r16.complete, true);
  near(withDead.scores.get('a')!.r16!, withoutDead.scores.get('a')!.r16!);
  assert.ok(withDead.scores.get('a')!.r16! < (1 - 1 / 6) * 100, '不会因剔除而抬高分数');
});

test('无任何历史时，只有上游确认无交易对才剔除；抓取失败仍留在分母', () => {
  const cfg = config();
  cfg.a4_rps.minCoverage = 0.5;
  const build = (status: ObservationRpsMember['dexStatus']) => {
    const item = missing(`no-history-${status}`);
    item.dexStatus = status;
    return item;
  };
  for (const status of ['pending', 'ok', 'error'] as const) {
    const result = calculateObservationRps([member('a', 20), member('b', 10), build(status)], NOW, cfg);
    assert.equal(result.coverage.r16.inactive, 0, `${status} 不能被当成失活`);
    assert.equal(result.coverage.r16.eligible, 3);
  }
  const absent = calculateObservationRps([member('a', 20), member('b', 10), build('absent')], NOW, cfg);
  assert.equal(absent.coverage.r16.inactive, 1);
  assert.equal(absent.coverage.r16.eligible, 2);
  assert.equal(absent.coverage.r16.complete, true);
});

test('已有历史的成员即使 dex 应答无交易对，仍按最后收盘时刻判定存活', () => {
  const cfg = config();
  cfg.a4_rps.minCoverage = 0.5;
  const delisted = member('delisted', 5);
  delisted.dexStatus = 'absent';
  const result = calculateObservationRps([member('a', 20), member('b', 10), delisted], NOW, cfg);
  assert.equal(result.coverage.r16.inactive, 0, '历史证据优先于 dex 应答');
  assert.equal(result.coverage.r16.available, 3);
});

test('采集整体中断时全池同时变陈旧，不会剔到只剩子集后伪造完整排名', () => {
  const cfg = config();
  const stalled = Array.from({ length: 10 }, (_, index) => {
    const item = member(`stalled-${index}`, index);
    item.candles15m = item.candles15m.map((bar) => ({ ...bar, openTime: bar.openTime - 40 * STEP }));
    return item;
  });
  const result = calculateObservationRps(stalled, NOW, cfg);
  assert.equal(result.coverage.r16.inactive, 10);
  assert.equal(result.coverage.r16.eligible, 0);
  assert.equal(result.coverage.r16.available, 0);
  assert.equal(result.coverage.r16.complete, false, '全池失活不能变成 0/0 的完整排名');
  for (const item of stalled) assert.deepEqual(result.bounds.get(item.ca)!, emptyBounds());
});

test('失活阈值来自配置，调大即可让原本被剔除的成员回到分母', () => {
  const cfg = config();
  const dormant = member('dormant');
  dormant.candles15m = [candle(NOW - 700 * STEP, 100), candle(NOW - 30 * STEP, 100)];
  const members = [member('a', 20), member('b', 10), dormant];
  assert.equal(calculateObservationRps(members, NOW, cfg).coverage.r16.inactive, 1);
  const relaxed = config();
  relaxed.a4_rps.inactiveAfterBars = 40;
  const result = calculateObservationRps(members, NOW, relaxed);
  assert.equal(result.coverage.r16.inactive, 0);
  assert.equal(result.coverage.r16.eligible, 3);
});

test('流动性低于 A2 下限的成员不进入排名分母，但需有正面证据才剔除', () => {
  const cfg = config();
  const rich = member('rich', 20);
  const poor = member('poor', 10);
  // 已验证流动性不足：一笔小单就能造成极端涨幅，纳入相对排名只会污染分母。
  poor.liquidity = cfg.a2_scale.liquidityMin - 1;
  const unknown = member('unknown', 30);
  unknown.liquidity = null;   // 没拿到流动性数据 ≠ 流动性不足，不能凭猜测缩小分母

  const result = calculateObservationRps([rich, poor, unknown], NOW, cfg);

  assert.equal(result.coverage.r16.illiquid, 1, '只剔除已证实流动性不足的那一个');
  assert.equal(result.coverage.r16.eligible, 2, 'rich 与未知流动性的 unknown 都应留在分母');
  assert.equal(result.scores.get('poor')!.r16, null, '被剔除者不产出评分');
});
