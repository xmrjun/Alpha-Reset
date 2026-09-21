import type { SocialQuality } from '../indicators/social-quality.js';
import type { StoreDatabase } from './db.js';

/**
 * 告警发生时的社交面判定。
 *
 * 为什么排队而不是当场查：查一次推特要 3~20 秒，挂在 notifier.notify() 那条路径上
 * 会让每条告警都晚这么久才推出去，上游一抖还可能把推送整个拖垮。所以告警时只写一条
 * 待查记录（纯本地，微秒级），由主循环慢慢消化 —— 和 outcomes 的结算是同一个模式。
 *
 * 延迟两分钟再查还有第二个理由：刚告警那一刻推文往往还没被推特索引完，立刻查到的偏少。
 *
 * 真正的目的不是给告警加个标签，而是攒出可对照的数据：这张表和 alert_outcomes 以
 * (ca, fired_at) 对齐，两个月后就能回答「刷量的币事后表现是不是真的更差」。
 */

export interface AlertSocialRow {
  readonly ca: string;
  readonly firedAt: number;
  readonly symbol: string | null;
  readonly chain: string | null;
  readonly checkedAt: number | null;
  readonly total: number | null;
  readonly manufactured: number | null;
  readonly botRatio: number | null;
  readonly clusters: number | null;
  readonly medianViews: number | null;
  readonly kols: string[];
  readonly verdict: string | null;
}

export interface PendingOptions {
  readonly delayMs: number;
  readonly cooldownMs: number;
  readonly dailyLimit: number;
  readonly limit: number;
}

const MAX_ATTEMPTS = 3;

export function createAlertSocialStore(db: StoreDatabase) {
  const insert = db.prepare(`INSERT INTO alert_social (ca, fired_at, symbol, chain, queued_at, attempts)
    VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT (ca, fired_at) DO NOTHING`);

  // 冷却用「同一个 ca 最近一次查完的时间」判断，而不是最近一次告警：
  // 一个币一天可能告警好几次，没必要每次都花钱。
  const due = db.prepare(`SELECT ca, fired_at AS firedAt, symbol, chain FROM alert_social pending
    WHERE checked_at IS NULL AND attempts < ? AND queued_at <= ?
      AND NOT EXISTS (SELECT 1 FROM alert_social done
        WHERE done.ca = pending.ca AND done.checked_at IS NOT NULL AND done.checked_at > ?)
    ORDER BY fired_at ASC LIMIT ?`);

  const finish = db.prepare(`UPDATE alert_social SET checked_at = ?, total = ?, manufactured = ?,
    bot_ratio = ?, clusters = ?, median_views = ?, kols = ?, verdict = ?
    WHERE ca = ? AND fired_at = ?`);
  const bumpAttempts = db.prepare('UPDATE alert_social SET attempts = attempts + 1 WHERE ca = ? AND fired_at = ?');
  const countToday = db.prepare('SELECT COUNT(*) AS n FROM alert_social WHERE checked_at >= ?');
  const list = db.prepare(`SELECT ca, fired_at AS firedAt, symbol, chain, checked_at AS checkedAt,
    total, manufactured, bot_ratio AS botRatio, clusters, median_views AS medianViews, kols, verdict
    FROM alert_social WHERE checked_at IS NOT NULL ORDER BY fired_at DESC LIMIT ?`);
  const grouped = db.prepare(`SELECT verdict, COUNT(*) AS n FROM alert_social
    WHERE checked_at >= ? GROUP BY verdict`);

  function hydrate(row: Record<string, unknown>): AlertSocialRow {
    let kols: string[] = [];
    try { kols = JSON.parse(String(row.kols ?? '[]')) as string[]; } catch { kols = []; }
    return { ...(row as unknown as AlertSocialRow), kols };
  }

  return {
    /** 告警时调用，幂等：同一条告警重复排队不会变成两次查询。 */
    queue(entry: { ca: string; firedAt: number; symbol: string | null; chain: string | null }, now: number): void {
      insert.run(entry.ca, entry.firedAt, entry.symbol, entry.chain, now);
    },

    pending(now: number, dayStart: number, options: PendingOptions):
      { ca: string; firedAt: number; symbol: string | null; chain: string | null }[] {
      if (this.usedToday(dayStart) >= options.dailyLimit) return [];
      return due.all(MAX_ATTEMPTS, now - options.delayMs, now - options.cooldownMs, options.limit) as
        { ca: string; firedAt: number; symbol: string | null; chain: string | null }[];
    },

    record(ca: string, firedAt: number, quality: SocialQuality, now: number): void {
      finish.run(now, quality.total, quality.manufactured, quality.botRatio, quality.clusters,
        quality.medianViews, JSON.stringify(quality.kols), quality.verdict, ca, firedAt);
    },

    /** 查失败：计数加一，留着下轮再试；到上限后 pending 自然不再取它。 */
    fail(ca: string, firedAt: number, _now: number): void {
      bumpAttempts.run(ca, firedAt);
    },

    usedToday(dayStart: number): number {
      return (countToday.get(dayStart) as { n: number }).n;
    },

    recent(limit: number): AlertSocialRow[] {
      return (list.all(limit) as Record<string, unknown>[]).map(hydrate);
    },

    summary(since: number): { checked: number; manufactured: number; mixed: number; organic: number; quiet: number } {
      const rows = grouped.all(since) as { verdict: string | null; n: number }[];
      const of = (name: string): number => rows.find((row) => row.verdict === name)?.n ?? 0;
      return { checked: rows.reduce((sum, row) => sum + row.n, 0), manufactured: of('manufactured'),
        mixed: of('mixed'), organic: of('organic'), quiet: of('quiet') };
    },
  };
}

export type AlertSocialStore = ReturnType<typeof createAlertSocialStore>;
