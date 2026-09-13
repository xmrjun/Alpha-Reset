import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { openDatabase } from '../../src/store/db.js';
import { createOutcomeStore, returnPct, type CohortEntry } from '../../src/store/outcomes.js';

const T = Date.parse('2026-09-13T04:00:00Z');
const HOUR = 3_600_000;
function fixture(t: TestContext) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  return { db, store: createOutcomeStore(db) };
}
/** 收益是浮点百分比，(120/100-1)*100 得 19.999999999999996，断言一律用近似。 */
const near = (actual: number | null, expected: number) =>
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `expected ${actual} ≈ ${expected}`);
const entry = (over: Partial<CohortEntry> = {}): CohortEntry => ({
  ca: 'ca-a', baselineAt: T, horizonHours: 1, alerted: true, tags: ['30m_ath_pullback'],
  seriesId: null, entryPrice: 100, ...over,
});

test('收益口径：非正价、非有限值与零入场价一律返回 null，不产生 Infinity', () => {
  near(returnPct(100, 120), 20);
  near(returnPct(100, 80), -20);
  near(returnPct(100, 100), 0);
  for (const [a, b] of [[0, 100], [-1, 100], [100, 0], [100, -1], [Number.NaN, 100],
    [100, Number.NaN], [Number.POSITIVE_INFINITY, 100], [100, Number.POSITIVE_INFINITY]] as const) {
    assert.equal(returnPct(a, b), null, `${a} -> ${b}`);
  }
});

test('到期前不结算；到期后才出现在待结算队列', (t) => {
  const { store } = fixture(t);
  store.recordCohort([entry({ horizonHours: 1 }), entry({ horizonHours: 4 })], T);
  assert.equal(store.pending(T).length, 0, 'T 时刻两个窗口都未到期');
  assert.equal(store.pending(T + HOUR).length, 1, '仅 1h 到期');
  assert.equal(store.pending(T + 4 * HOUR).length, 2);
});

test('结算写入收益后不再重复出现在队列，且不被后续登记覆盖', (t) => {
  const { store } = fixture(t);
  store.recordCohort([entry()], T);
  const [row] = store.pending(T + HOUR);
  assert.ok(row);
  assert.equal(store.settle(row, 130, T + HOUR), true);
  assert.deepEqual(store.pending(T + HOUR), []);
  // 同 T 重复登记（例如迟到数据触发补算）不得改写已结算结果
  store.recordCohort([entry({ entryPrice: 999, alerted: false, tags: [] })], T + 2 * HOUR);
  const stats = store.stats();
  assert.equal(stats[0]!.alerted.n, 1);
  near(stats[0]!.alerted.median, 30);
});

test('到期取不到同源退出价时记为无结果，停止重复扫描但不写入收益', (t) => {
  const { store } = fixture(t);
  store.recordCohort([entry()], T);
  const [row] = store.pending(T + HOUR);
  assert.equal(store.settle(row!, null, T + HOUR), false, '无退出价不算结算成功');
  assert.deepEqual(store.pending(T + HOUR), [], '已标记，不再反复扫描');
  assert.deepEqual(store.stats(), [], '不产生任何统计样本');
});

test('告警组与对照组同表统计，中位数与胜率分别计算', (t) => {
  const { store } = fixture(t);
  const rows: CohortEntry[] = [];
  // 告警组 4 个：+10 +20 -5 -10 → 中位 2.5，胜率 50%
  const alerted = [110, 120, 95, 90];
  alerted.forEach((exit, i) => rows.push(entry({ ca: `hit-${i}`, alerted: true })));
  // 对照组 3 个：-1 -2 -3 → 中位 -2，胜率 0%
  const control = [99, 98, 97];
  control.forEach((exit, i) => rows.push(entry({ ca: `ctl-${i}`, alerted: false, tags: [] })));
  store.recordCohort(rows, T);
  const pending = store.pending(T + HOUR);
  assert.equal(pending.length, 7);
  const exits = [...alerted, ...control];
  pending.forEach((row) => {
    const index = rows.findIndex((r) => r.ca === row.ca);
    store.settle(row, exits[index]!, T + HOUR);
  });
  const [stat] = store.stats();
  assert.ok(stat);
  assert.equal(stat.horizonHours, 1);
  assert.equal(stat.alerted.n, 4);
  near(stat.alerted.median, 2.5);
  assert.equal(stat.alerted.winRate, 50);
  assert.equal(stat.control.n, 3);
  near(stat.control.median, -2);
  assert.equal(stat.control.winRate, 0);
});

test('按标签统计逐标签计入，多标签事件在每个标签下各出现一次', (t) => {
  const { store } = fixture(t);
  store.recordCohort([
    entry({ ca: 'a', tags: ['low_vol_30m', '30m_ath_pullback'] }),
    entry({ ca: 'b', tags: ['low_vol_30m'] }),
  ], T);
  for (const [row, exit] of store.pending(T + HOUR).map((r) => [r, r.ca === 'a' ? 120 : 90] as const)) {
    store.settle(row, exit, T + HOUR);
  }
  const tags = store.tagStats();
  const low = tags.find((x) => x.tag === 'low_vol_30m')!;
  const ath = tags.find((x) => x.tag === '30m_ath_pullback')!;
  assert.equal(low.n, 2); near(low.median, 5); assert.equal(low.winRate, 50);   // [-10, +20] 的中位是 5
  assert.equal(ath.n, 1); near(ath.median, 20); assert.equal(ath.winRate, 100);
});

test('since 之前的数据不参与统计，可按时间窗口比较不同版本', (t) => {
  const { store } = fixture(t);
  store.recordCohort([entry({ ca: 'old', baselineAt: T - 48 * HOUR }), entry({ ca: 'new' })], T);
  for (const row of store.pending(T + HOUR)) store.settle(row, row.ca === 'old' ? 50 : 150, T + HOUR);
  assert.equal(store.stats()[0]!.alerted.n, 2);
  assert.equal(store.stats(T)[0]!.alerted.n, 1);
  near(store.stats(T)[0]!.alerted.median, 50);
});

test('非正入场价不登记，不会产生无法结算的僵尸行', (t) => {
  const { store } = fixture(t);
  const written = store.recordCohort([entry({ ca: 'zero', entryPrice: 0 }),
    entry({ ca: 'neg', entryPrice: -5 }), entry({ ca: 'nan', entryPrice: Number.NaN }),
    entry({ ca: 'ok' })], T);
  assert.equal(written, 1);
  assert.deepEqual(store.pending(T + HOUR).map((r) => r.ca), ['ok']);
});

test('迟到补算可把对照组升级为告警组并补齐标签，反向不降级', (t) => {
  const { store } = fixture(t);
  store.recordCohort([entry({ alerted: false, tags: [] })], T);
  store.recordCohort([entry({ alerted: true, tags: ['rsi_lt50_60m'] })], T + 60_000);
  store.recordCohort([entry({ alerted: false, tags: [] })], T + 120_000);
  const [row] = store.pending(T + HOUR);
  store.settle(row!, 110, T + HOUR);
  assert.equal(store.stats()[0]!.alerted.n, 1, '保持告警组');
  assert.equal(store.stats()[0]!.control.n, 0);
  assert.deepEqual(store.tagStats().map((x) => x.tag), ['rsi_lt50_60m']);
});
