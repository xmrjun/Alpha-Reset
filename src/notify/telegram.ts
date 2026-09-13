import { z } from 'zod';
import type { RpsBounds } from '../indicators/observation-rps.js';
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

/**
 * 紧凑美元格式，与前端 money() 完全一致，保证同一条告警在推送和页面上读数相同。
 * 缺值返回 null 由调用方整段省略，不在推送里显示占位符。
 */
export function formatUsd(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return '$' + new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

export interface Notification {
  ca: string;
  pool: PoolItem;
  now: number;
  tags: AlertTag[];
  rpsScores: RpsScores;
  rpsBounds?: RpsBounds;
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
    const boundedScores = RPS_KEYS.flatMap((key) => {
      const bound = input.rpsBounds?.[key];
      if (input.rpsScores[key] !== null || !bound || bound.status !== 'pass'
        || !(bound.lower > opts.cfg.a4_rps.periods[key].threshold)) return [];
      return [key.toUpperCase() + ' ≥ ' + (Math.floor(bound.lower * 10) / 10).toFixed(1) + '（完整池保守下界） > ' + opts.cfg.a4_rps.periods[key].threshold];
    });
    scores.push(...boundedScores);
    let messages = 0;
    for (const group of groups) {
      const text = [
        // 市值取 pool.marketCap —— A2 门控判定用的就是它，显示值必须与判定值同源；
        // dex.marketCap 只在成员尚未固定序列时刷新，实测中位陈旧 16 小时，不可用于信号。
        [input.pool.symbol?.slice(0, 80) || '未知代币', formatUsd(input.pool.marketCap),
          new Date(input.now).toISOString()].filter(Boolean).join(' · '),
        input.ca.slice(0, 256), group.map((tag) => `【${TAG_DETAILS[tag].label}】`).join('，'),
        scores.join(' · '), `K 线：${chartUrl}`,
      ].filter(Boolean).join('\n');
      const ids = opts.db.transaction(() => group.map((tag) => store.recordAlert({
        ca: input.ca, tag, firedAt: input.now,
        payload: { ...input.payload, tags: group, rpsScores: input.rpsScores, rpsBounds: input.rpsBounds ?? null, dryRun: opts.dryRun },
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
