import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { loadStrategy } from '../../src/config/strategy.js';
import { createNotifier, TelegramClient, TelegramError, type Notification } from '../../src/notify/telegram.js';
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
