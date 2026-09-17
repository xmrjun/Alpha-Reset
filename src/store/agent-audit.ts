import { createHmac, randomBytes } from 'node:crypto';
import type { StoreDatabase } from './db.js';

/**
 * agent 工具调用的证据链。
 *
 * 为什么要有：铁律 7 的「不解析、不存储、不记录」管的是**用户的东西**——Orbio key
 * 和对话内容。而工具调用是**在本机上花本站的钱**，那是另一条边界：必须可查证。
 * 把两者当成同一条规则，等于为了保护前者放弃后者的全部可追溯性，出账单时只能猜。
 *
 * 两个设计选择：
 * - 访客只存 HMAC 摘要，不存地址。既能回答「是不是同一个人」，又不在库里留下
 *   访客住址；这个库是可以被备份、被拷走的。
 * - 被拒的调用照样记。只记成功调用等于看不见攻击：并发爆破在成功日志里就是一堆
 *   正常查询，在含 budget_exhausted 的日志里一眼就是攻击。
 *
 * 顺带解决配额持久化：额度直接从这张表算，进程重启不清零 —— 否则把进程打崩
 * 就能重置当天额度，而 systemd 配的是 Restart=always。
 */

export type AuditOutcome = 'pending' | 'ok' | 'invalid_args' | 'budget_exhausted'
  | 'not_configured' | 'upstream_failed' | 'error';

export interface AuditRow {
  readonly id: number;
  readonly at: number;
  readonly visitor: string;
  readonly tool: string;
  readonly argDigest: string;
  readonly cached: boolean;
  readonly costUsd: number | null;
  readonly outcome: AuditOutcome;
}

export interface BeginEntry {
  readonly at: number;
  readonly visitor: string;
  readonly tool: string;
  readonly arg: string;
  readonly cached: boolean;
}

export function createAgentAuditStore(db: StoreDatabase) {
  const readSecret = db.prepare('SELECT payload FROM runtime_state WHERE key = ?');
  const writeSecret = db.prepare('INSERT INTO runtime_state (key, payload, updated_at) VALUES (?, ?, ?)'
    + ' ON CONFLICT (key) DO UPDATE SET payload = excluded.payload');

  /**
   * 摘要用的盐，首次真正需要时才生成并落库。
   *
   * 不能在构造时就写：createWebServer 会在启动时建这个 store，而看板的读取路径
   * 必须对数据库零写入（只读副本上也要能跑起来）。只读库上写入失败就退回进程内
   * 临时盐 —— 那种场景本来也不会记录审计。
   */
  let secret: string | null = null;
  const saltOf = (): string => {
    if (secret !== null) return secret;
    const row = readSecret.get('audit_secret') as { payload: string } | undefined;
    if (row?.payload) { secret = row.payload; return secret; }
    const fresh = randomBytes(32).toString('hex');
    try { writeSecret.run('audit_secret', fresh, Date.now()); } catch { /* 只读库 */ }
    secret = fresh;
    return secret;
  };

  const digest = (value: string): string =>
    createHmac('sha256', saltOf()).update(value).digest('hex').slice(0, 16);

  const insert = db.prepare(`INSERT INTO agent_tool_calls
    (at, visitor, tool, arg_digest, cached, cost_usd, outcome) VALUES (?, ?, ?, ?, ?, NULL, 'pending')`);
  const finish = db.prepare('UPDATE agent_tool_calls SET outcome = ?, cost_usd = ?,'
    + ' cached = COALESCE(?, cached) WHERE id = ?');
  const list = db.prepare(`SELECT id, at, visitor, tool, arg_digest AS argDigest, cached,
    cost_usd AS costUsd, outcome FROM agent_tool_calls ORDER BY id DESC LIMIT ?`);
  // 在途与成功都占额度：额度必须在打上游之前就占住，否则并发全部放行。
  const countAll = db.prepare(`SELECT COUNT(*) AS n FROM agent_tool_calls
    WHERE tool = ? AND at >= ? AND cached = 0 AND outcome IN ('pending', 'ok')`);
  const countByVisitor = db.prepare(`SELECT COUNT(*) AS n FROM agent_tool_calls
    WHERE tool = ? AND visitor = ? AND at >= ? AND cached = 0 AND outcome IN ('pending', 'ok')`);
  const sumCost = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM agent_tool_calls WHERE at >= ?');

  return {
    /** 调用开始时先落一条 pending：这条记录本身就是额度占位。 */
    begin(entry: BeginEntry): number {
      const result = insert.run(entry.at, digest(entry.visitor), entry.tool,
        digest(entry.arg), entry.cached ? 1 : 0);
      return Number(result.lastInsertRowid);
    },
    /**
     * 结算：失败的记录不再占额度，等于把占位退回去。
     * cached 在开始时还不知道（要进到查询里才清楚），所以这里补记。
     */
    settle(id: number, outcome: AuditOutcome, costUsd?: number, cached?: boolean): void {
      // cached 不传就保持 begin 时的值，免得调用方漏传一个参数就把标记冲掉。
      finish.run(outcome, costUsd ?? null, cached === undefined ? null : (cached ? 1 : 0), id);
    },
    usedToday(tool: string, dayStart: number): number {
      return (countAll.get(tool, dayStart) as { n: number }).n;
    },
    usedByVisitor(tool: string, visitor: string, dayStart: number): number {
      return (countByVisitor.get(tool, digest(visitor), dayStart) as { n: number }).n;
    },
    spentSince(since: number): number {
      return (sumCost.get(since) as { total: number }).total;
    },
    recent(limit: number): AuditRow[] {
      return (list.all(limit) as (Omit<AuditRow, 'cached'> & { cached: number })[])
        .map((row) => ({ ...row, cached: row.cached === 1 }));
    },
  };
}

export type AgentAuditStore = ReturnType<typeof createAgentAuditStore>;
