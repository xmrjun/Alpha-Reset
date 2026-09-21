import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SocialQuality } from '../../src/indicators/social-quality.js';
import { openDatabase } from '../../src/store/db.js';
import { createAlertSocialStore } from '../../src/store/alert-social.js';

const minute = 60_000;
const hour = 60 * minute;
const t0 = Date.parse('2026-09-21T08:00:00Z');
const dayStart = Date.parse('2026-09-21T00:00:00Z');
const CA = '0x648a5382bdcf286e7ff5122d01a983db314e620a';

const quality = (over: Partial<SocialQuality> = {}): SocialQuality => ({
  total: 10, organic: 2, manufactured: 8, botRatio: 0.8, clusters: 2, medianViews: 76,
  kols: [], mentions: [], verdict: 'manufactured', posts: [], ...over,
});

function store() {
  const db = openDatabase(':memory:');
  return createAlertSocialStore(db);
}

const opts = { delayMs: 2 * minute, cooldownMs: 6 * hour, dailyLimit: 200, limit: 3 };

test('告警时只排队，不查；到点才取出来', () => {
  const s = store();
  s.queue({ ca: CA, firedAt: t0, symbol: 'PANCHU', chain: 'arc' }, t0);

  assert.deepEqual(s.pending(t0 + minute, dayStart, opts), [], '两分钟没到不该取出来');
  const due = s.pending(t0 + 3 * minute, dayStart, opts);
  assert.equal(due.length, 1);
  assert.equal(due[0]?.ca, CA);
  assert.equal(due[0]?.symbol, 'PANCHU');
});

test('同一条告警重复排队不会变成两次查询', () => {
  const s = store();
  s.queue({ ca: CA, firedAt: t0, symbol: 'X', chain: 'arc' }, t0);
  s.queue({ ca: CA, firedAt: t0, symbol: 'X', chain: 'arc' }, t0 + 1000);
  assert.equal(s.pending(t0 + 3 * minute, dayStart, opts).length, 1);
});

test('查完落库后就不再出现在待查里', () => {
  const s = store();
  s.queue({ ca: CA, firedAt: t0, symbol: 'X', chain: 'arc' }, t0);
  s.record(CA, t0, quality(), t0 + 3 * minute);
  assert.deepEqual(s.pending(t0 + 4 * minute, dayStart, opts), []);

  const row = s.recent(10)[0]!;
  assert.equal(row.verdict, 'manufactured');
  assert.equal(row.botRatio, 0.8);
  assert.equal(row.total, 10);
});

test('同一个币六小时内不重复花钱，哪怕又告警了一次', () => {
  const s = store();
  s.queue({ ca: CA, firedAt: t0, symbol: 'X', chain: 'arc' }, t0);
  s.record(CA, t0, quality(), t0 + 3 * minute);

  s.queue({ ca: CA, firedAt: t0 + hour, symbol: 'X', chain: 'arc' }, t0 + hour);
  assert.deepEqual(s.pending(t0 + hour + 3 * minute, dayStart, opts), [], '冷却期内不取');

  const later = s.pending(t0 + 7 * hour, dayStart, opts);
  assert.equal(later.length, 1, '过了冷却期才轮到它');
});

test('查失败会重试，连续失败到上限就放弃', () => {
  const s = store();
  s.queue({ ca: CA, firedAt: t0, symbol: 'X', chain: 'arc' }, t0);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(s.pending(t0 + (3 + i) * minute, dayStart, opts).length, 1, `第 ${i + 1} 次应当还能取到`);
    s.fail(CA, t0, t0 + (3 + i) * minute);
  }
  assert.deepEqual(s.pending(t0 + 10 * minute, dayStart, opts), [], '失败三次后放弃，不再无限重试');
});

test('每日上限卡住之后一条都不再取，避免告警暴增时烧钱', () => {
  const s = store();
  for (let i = 0; i < 5; i += 1) {
    s.queue({ ca: `0x${String(i).padStart(40, '0')}`, firedAt: t0 + i, symbol: 'X', chain: 'arc' }, t0);
    s.record(`0x${String(i).padStart(40, '0')}`, t0 + i, quality(), t0 + minute);
  }
  s.queue({ ca: CA, firedAt: t0 + 100, symbol: 'X', chain: 'arc' }, t0);
  assert.deepEqual(s.pending(t0 + 5 * minute, dayStart, { ...opts, dailyLimit: 5 }), [], '当天已用满');
  assert.equal(s.usedToday(dayStart), 5);
});

test('一次最多取 limit 条，别让一轮主循环卡太久', () => {
  const s = store();
  for (let i = 0; i < 10; i += 1) {
    s.queue({ ca: `0x${String(i).padStart(40, '0')}`, firedAt: t0 + i, symbol: 'X', chain: 'arc' }, t0);
  }
  assert.equal(s.pending(t0 + 3 * minute, dayStart, opts).length, 3);
});

test('汇总按判定分组，供面板直接展示', () => {
  const s = store();
  const seed = (n: number, verdict: SocialQuality['verdict']) => {
    for (let i = 0; i < n; i += 1) {
      const ca = `0x${verdict}${String(i).padStart(30, '0')}`;
      s.queue({ ca, firedAt: t0 + i, symbol: 'X', chain: 'arc' }, t0);
      s.record(ca, t0 + i, quality({ verdict }), t0 + minute);
    }
  };
  seed(3, 'manufactured'); seed(2, 'organic'); seed(1, 'quiet');
  const summary = s.summary(dayStart);
  assert.equal(summary.checked, 6);
  assert.equal(summary.manufactured, 3);
  assert.equal(summary.organic, 2);
  assert.equal(summary.quiet, 1);
});
