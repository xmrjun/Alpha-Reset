import { loadConfig } from '../config.js';
import { loadStrategy } from '../config/strategy.js';
import { openDatabase } from '../store/db.js';
import { createHistoryStore } from '../store/history.js';
import { createRuntimeStore } from '../store/runtime.js';
import { backfill } from './backfill.js';

/**
 * 观察组历史 CA 回填入口。
 *
 * 上游最早数据为 2026-04-11（sync 的 id=1），约 5 个月、21 万条记录。
 * `sync` 不支持按群筛选，只能全量翻页再本地过滤（三群约占 1.3%），
 * 按 limit=500 需约 423 次请求、11 分钟。
 *
 * 断点续传：进度写在 runtime_state 的 backfill_after_id，中断后重跑自动接续。
 * 增量：日常只需从上次的 after_id 继续，几次请求即可。
 */
const PROGRESS_KEY = 'backfill_after_id';

async function main(): Promise<void> {
  const config = loadConfig();
  const cfg = loadStrategy();
  const db = openDatabase(config.databasePath);
  const history = createHistoryStore(db);
  const state = createRuntimeStore(db);

  const raw = db.prepare('SELECT payload FROM runtime_state WHERE key = ?').get(PROGRESS_KEY) as
    { payload: string } | undefined;
  const startAfterId = raw ? (JSON.parse(raw.payload) as { afterId: number }).afterId : 0;
  const before = history.count();
  const maxPages = process.env.BACKFILL_MAX_PAGES ? Number(process.env.BACKFILL_MAX_PAGES) : undefined;

  const log = (event: Record<string, unknown>) => { console.log(JSON.stringify(event)); };
  log({ event: 'backfill_start', startAfterId, existing: before, groups: cfg.observeGroups });

  const saveProgress = (afterId: number) => {
    db.prepare(`INSERT INTO runtime_state (key, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(PROGRESS_KEY, JSON.stringify({ afterId }), Date.now());
  };

  try {
    const result = await backfill({
      baseUrl: config.erwaApiBase,
      token: config.erwaApiToken,
      groups: cfg.observeGroups,
      startAfterId,
      ...(maxPages === undefined ? {} : { maxPages }),
      onProgress: ({ afterId, scanned, kept }) => {
        // 每页都存进度：11 分钟的任务中断后不必从头再来
        saveProgress(afterId);
        if (scanned % 20_000 === 0) log({ event: 'backfill_progress', afterId, scanned, kept });
      },
    });

    const saved = history.save(result.items.map((item) => ({
      ca: item.ca!,
      symbol: item.symbol ?? null,
      chain: item.chain ?? null,
      groupName: item.group_name ?? null,
      firstMentionId: item.id,
      firstMentionAt: Date.parse(`${item.create_time ?? ''}Z`) || Date.now(),
    })), Date.now());
    saveProgress(result.lastAfterId);

    log({ event: 'backfill_done', scanned: result.scanned, matched: result.kept, saved,
      totalInDb: history.count(), added: history.count() - before,
      earliest: result.earliest, lastAfterId: result.lastAfterId });
    for (const row of history.byGroup()) log({ event: 'backfill_by_group', ...row });
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(`回填失败: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  process.exitCode = 1;
});
