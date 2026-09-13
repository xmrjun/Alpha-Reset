import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { loadStrategy } from '../../src/config/strategy.js';
import { createNotifier, formatUsd, TelegramClient, TelegramError, type Notification } from '../../src/notify/telegram.js';
import { emptyBounds } from '../../src/indicators/observation-rps.js';
import { openDatabase } from '../../src/store/db.js';
import { createAlertStore } from '../../src/store/alerts.js';
import { emptyScores, HOUR_MS } from '../../src/market.js';
import { SAMPLE_STRATEGY, poolItem } from '../helpers.js';

const notification = (): Notification => ({ ca: 'test-ca', pool: poolItem(), now: 100 * HOUR_MS,
  tags: ['30m_ath_pullback', 'low_vol_60m', 'rsi_lt50_4h'],
  rpsScores: { ...emptyScores(), r96: 90 }, payload: { reasons: { a1: true } } });

test('同 CA 多标签合并，附链接和 RPS，逐标签冷却且边界可再推', async (t) => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const messages: string[] = [];
  const notifier = createNotifier({ db, cfg: loadStrategy(SAMPLE_STRATEGY), dryRun: false, publicSite: 'https://alpha.example',
    send: async (text) => { messages.push(text); } });
  const input = notification();
  await notifier.notify(input);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /30分钟历史新高回调提醒.*低量60分钟.*4小时RSI小于50/s);
  assert.match(messages[0]!, /https:\/\/alpha.example\/ca\/test-ca/);
  assert.match(messages[0]!, /R96 90.0 > 85/);
  await notifier.notify(input);
  assert.equal(messages.length, 1);
  const next = await notifier.notify({ ...input, now: input.now + 2 * HOUR_MS });
  assert.deepEqual(next.tags, ['30m_ath_pullback']);
  assert.equal(createAlertStore(db).getAlerts().items.every((row) => row.pushed), true);
});

test('并发重复通知串行检查冷却，避免重复推送', async (t) => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  let count = 0;
  const notifier = createNotifier({ db, cfg: loadStrategy(SAMPLE_STRATEGY), dryRun: false, publicSite: 'https://example.test',
    send: async () => { count++; } });
  await Promise.all([notifier.notify(notification()), notifier.notify(notification())]);
  assert.equal(count, 1);
});

test('干跑零网络，审计记录不标为已推送，不阻塞真实推送', async (t) => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  let sends = 0;
  const logs: string[] = [];
  const opts = { db, cfg: loadStrategy(SAMPLE_STRATEGY), publicSite: 'https://example.test',
    send: async () => { sends++; }, log: (text: string) => logs.push(text) };
  await createNotifier({ ...opts, dryRun: true }).notify(notification());
  assert.equal(sends, 0);
  assert.equal(logs.length, 1);
  assert.equal(createAlertStore(db).getAlerts().items.every((row) => !row.pushed), true);
  await createNotifier({ ...opts, dryRun: false }).notify(notification());
  assert.equal(sends, 1);
});

test('发送失败保留未推送审计，后续可重试；冷却轮数可配置', async (t) => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const cfg = loadStrategy(SAMPLE_STRATEGY); cfg.alerting.cooldownBars = 1;
  let fail = true;
  const notifier = createNotifier({ db, cfg, dryRun: false, publicSite: 'https://example.test',
    send: async () => { if (fail) throw new TelegramError(); } });
  await assert.rejects(notifier.notify(notification()), TelegramError);
  assert.equal(createAlertStore(db).getAlerts().items.every((row) => !row.pushed), true);
  fail = false;
  await notifier.notify(notification());
  const result = await notifier.notify({ ...notification(), now: notification().now + HOUR_MS });
  assert.deepEqual(result.tags, ['30m_ath_pullback', 'low_vol_60m']);
});

test('Telegram 校验成功标记，HTTP/业务/网络错误不回显认证值', async (t) => {
  let mode = 'ok';
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(JSON.parse(String(init.body)).text, '<plain-text>');
    assert.equal(JSON.parse(String(init.body)).parse_mode, undefined);
    if (mode === 'network') throw new Error('fake-telegram-private');
    return mode === 'http' ? new Response('fake-telegram-private', { status: 401 }) : Response.json({ ok: mode === 'ok' });
  });
  const client = new TelegramClient({ token: 'fake-telegram-private', chatId: '123' });
  await client.send('<plain-text>');
  for (mode of ['http', 'business', 'network']) {
    await assert.rejects(client.send('<plain-text>'), (error: unknown) => {
      assert.ok(error instanceof TelegramError);
      assert.doesNotMatch(inspect(error), /fake-telegram-private/);
      return true;
    });
  }
  assert.doesNotMatch(inspect(client), /fake-telegram-private/);
});

test('缺数告警明确写保守下界，审计保留范围而不伪造精确分数', async (t) => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const texts: string[] = [];
  const notifier = createNotifier({ db, cfg: loadStrategy(SAMPLE_STRATEGY), dryRun: false,
    publicSite: 'https://example.test', send: async (text) => { texts.push(text); } });
  const rpsBounds = { ...emptyBounds(), r96: { lower: 86.666, upper: 96, status: 'pass' as const } };
  await notifier.notify({ ...notification(), rpsScores: emptyScores(), rpsBounds });
  assert.match(texts[0]!, /R96 ≥ 86\.6（完整池保守下界） > 85/);
  const payload = createAlertStore(db).getAlerts().items[0]!.payload as { rpsScores: { r96: null }; rpsBounds: typeof rpsBounds };
  assert.equal(payload.rpsScores.r96, null);
  assert.deepEqual(payload.rpsBounds.r96, rpsBounds.r96);
});

test('推送首行带上触发时市值，与 A2 判定用的 pool.marketCap 同源', async (t) => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const messages: string[] = [];
  const notifier = createNotifier({ db, cfg: loadStrategy(SAMPLE_STRATEGY), dryRun: false,
    publicSite: 'https://alpha.example', send: async (text) => { messages.push(text); } });
  const input = notification();
  input.pool.marketCap = 2_140_000;
  // 陈旧的 dex 快照不得参与显示：实测它在成员固定序列后不再刷新
  input.payload = { ...input.payload as object, dex: { marketCap: 9_999_999 } };
  await notifier.notify(input);
  const first = messages[0]!.split('\n')[0]!;
  assert.match(first, /^TEST · \$2\.14M · /, '符号 · 市值 · 时间');
  assert.ok(!messages[0]!.includes('9,999,999') && !messages[0]!.includes('$10M'), '不得使用 dex 的陈旧市值');
});

test('市值缺失或非有限时整段省略，不在推送里留占位符', async (t) => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  for (const value of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const messages: string[] = [];
    const notifier = createNotifier({ db, cfg: loadStrategy(SAMPLE_STRATEGY), dryRun: false,
      publicSite: 'https://alpha.example', send: async (text) => { messages.push(text); } });
    const input = notification();
    input.ca = `ca-${String(value)}`;
    input.pool.marketCap = value as number | null;
    await notifier.notify(input);
    const first = messages[0]!.split('\n')[0]!;
    assert.equal(first, `TEST · ${new Date(input.now).toISOString()}`, String(value));
    assert.ok(!first.includes('—') && !first.includes('$'), '不显示占位符');
  }
});

test('触发时市值写入告警 payload 并被冻结，供告警历史回看', async (t) => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const notifier = createNotifier({ db, cfg: loadStrategy(SAMPLE_STRATEGY), dryRun: false,
    publicSite: 'https://alpha.example', send: async () => {} });
  const input = notification();
  input.payload = { ...input.payload as object, marketCap: 1_250_000 };
  await notifier.notify(input);
  const rows = createAlertStore(db).getAlerts().items;
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal((row.payload as { marketCap?: unknown }).marketCap, 1_250_000);
  }
});

test('金额格式与前端 money() 一致，缺值返回 null 交由调用方省略', () => {
  assert.equal(formatUsd(2_140_000), '$2.14M');
  assert.equal(formatUsd(51_000), '$51K');
  assert.equal(formatUsd(0), '$0');
  for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(formatUsd(value), null, String(value));
  }
});
