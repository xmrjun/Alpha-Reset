import type { AlertTag } from '../types.js';
import type { StoreDatabase } from './db.js';

export interface AlertInput {
  ca: string;
  tag: AlertTag;
  firedAt: number;
  payload: unknown;
  pushed?: boolean;
}

export interface AlertRow extends Omit<AlertInput, 'pushed'> {
  id: number;
  pushed: boolean;
}

export interface AlertFilter {
  ca?: string;
  tag?: AlertTag;
  from?: number;
  to?: number;
  limit?: number;
}

export function createAlertStore(db: StoreDatabase) {
  const insert = db.prepare(`INSERT INTO alerts (ca, tag, fired_at, payload, pushed)
    VALUES (@ca, @tag, @firedAt, @payload, @pushed)`);
  const cooldown = db.prepare(`SELECT 1 FROM alerts
    WHERE ca = ? AND tag = ? AND pushed = 1 AND fired_at > ? AND fired_at <= ? LIMIT 1`);
  const mark = db.prepare('UPDATE alerts SET pushed = 1 WHERE id = ?');
  const where = `WHERE (@ca IS NULL OR ca = @ca) AND (@tag IS NULL OR tag = @tag)
    AND (@from IS NULL OR fired_at >= @from) AND (@to IS NULL OR fired_at <= @to)`;
  const list = db.prepare(`SELECT id, ca, tag, fired_at AS firedAt, payload, pushed
    FROM alerts ${where} ORDER BY fired_at DESC, id DESC LIMIT @limit`);
  const count = db.prepare(`SELECT COUNT(*) AS total FROM alerts ${where}`);

  return {
    recordAlert(input: AlertInput): number {
      const payload = JSON.stringify(input.payload);
      if (payload === undefined) throw new TypeError('告警快照必须是 JSON 可序列化值');
      return Number(insert.run({ ...input, payload, pushed: input.pushed ? 1 : 0 }).lastInsertRowid);
    },
    /** 仅成功推送消耗冷却；干跑或失败记录不能抑制真实推送。 */
    isInCooldown(ca: string, tag: AlertTag, now: number, cooldownMs: number): boolean {
      if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
        throw new RangeError('cooldownMs 必须是非负有限值');
      }
      return cooldown.get(ca, tag, now - cooldownMs, now) !== undefined;
    },
    markPushed: db.transaction((ids: number[]): void => {
      for (const id of ids) mark.run(id);
    }),
    getAlerts(filter: AlertFilter = {}): { items: AlertRow[]; total: number } {
      const limit = filter.limit ?? 200;
      if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('limit 必须是非负整数');
      const params = { ca: filter.ca ?? null, tag: filter.tag ?? null,
        from: filter.from ?? null, to: filter.to ?? null, limit };
      const rows = list.all(params) as (Omit<AlertRow, 'payload' | 'pushed'> & {
        payload: string; pushed: number;
      })[];
      return {
        items: rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown,
          pushed: row.pushed === 1 })),
        total: (count.get(params) as { total: number }).total,
      };
    },
  };
}
