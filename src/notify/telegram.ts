import { z } from 'zod';
import type { StrategyConfig } from '../config/strategy.js';
import { PERIOD_MS, RPS_KEYS, TAG_DETAILS, type RpsScores } from '../market.js';
import { createAlertStore } from '../store/alerts.js';
import type { StoreDatabase } from '../store/db.js';
import type { AlertTag, PoolItem } from '../types.js';

export class TelegramError extends Error {
  readonly code = 'TELEGRAM_FAILED';
  constructor() { super('Telegram 推送失败或配置缺失'); this.name = 'TelegramError'; }
}

export class TelegramClient {
  #token: string;
  #chatId: string;
  constructor(opts: { token: string; chatId: string }) {
    this.#token = opts.token;
    this.#chatId = opts.chatId;
  }
  async send(text: string): Promise<void> {
    if (!this.#token || !this.#chatId) throw new TelegramError();
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.#token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ chat_id: this.#chatId, text, link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new TelegramError(); }
      const body = z.object({ ok: z.literal(true) }).safeParse(await response.json());
      if (!body.success) throw new TelegramError();
    } catch { throw new TelegramError(); }
  }
}

export interface Notification {
  ca: string;
  pool: PoolItem;
  now: number;
  tags: AlertTag[];
  rpsScores: RpsScores;
  payload: Record<string, unknown>;
}

export function createNotifier(opts: {
  db: StoreDatabase; cfg: StrategyConfig; dryRun: boolean; publicSite: string;
  send: (text: string) => Promise<void>; log?: (message: string) => void;
}) {
  const store = createAlertStore(opts.db);
  let queue = Promise.resolve();
  const log = opts.log ?? console.log;
  async function dispatch(input: Notification): Promise<{ tags: AlertTag[]; messages: number }> {
    const tags = [...new Set(input.tags)].filter((tag) => !store.isInCooldown(input.ca, tag, input.now,
      PERIOD_MS[TAG_DETAILS[tag].period] * opts.cfg.alerting.cooldownBars));
    const groups = opts.cfg.alerting.mergeTagsPerCa ? (tags.length ? [tags] : []) : tags.map((tag) => [tag]);
    const chartUrl = new URL(`/ca/${encodeURIComponent(input.ca)}`, opts.publicSite).href;
    const scores = RPS_KEYS.filter((key) => input.rpsScores[key] !== null
      && input.rpsScores[key]! > opts.cfg.a4_rps.periods[key].threshold)
      .map((key) => `${key.toUpperCase()} ${input.rpsScores[key]!.toFixed(1)} > ${opts.cfg.a4_rps.periods[key].threshold}`);
    let messages = 0;
    for (const group of groups) {
      const text = [
        `${input.pool.symbol?.slice(0, 80) || '未知代币'} · ${new Date(input.now).toISOString()}`,
        input.ca.slice(0, 256), group.map((tag) => `【${TAG_DETAILS[tag].label}】`).join('，'),
        scores.join(' · '), `K 线：${chartUrl}`,
      ].filter(Boolean).join('\n');
      const ids = opts.db.transaction(() => group.map((tag) => store.recordAlert({
        ca: input.ca, tag, firedAt: input.now,
        payload: { ...input.payload, tags: group, rpsScores: input.rpsScores, dryRun: opts.dryRun },
      })))();
      if (opts.dryRun) log(`[DRY_RUN] ${text}`);
      else { await opts.send(text); store.markPushed(ids); }
      messages++;
    }
    return { tags, messages };
  }
  return {
    notify(input: Notification) {
      const result = queue.then(() => dispatch(input));
      queue = result.then(() => {}, () => {});
      return result;
    },
  };
}
