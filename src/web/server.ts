import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { loadStrategy, type StrategyConfig } from '../config/strategy.js';
import { rsi } from '../indicators/rsi.js';
import { sma } from '../indicators/sma.js';
import { INTERVAL_MS, PERIOD_MS, RPS_KEYS, TAG_DETAILS, closedCandles, contiguousTail, type Period } from '../market.js';
import { evaluate } from '../rules/evaluate.js';
import { usageDate } from '../scheduler/quota.js';
import { openDatabase, type StoreDatabase } from '../store/db.js';
import { createPoolStore } from '../store/pool.js';
import { readMarketInputs } from '../store/snapshot.js';
import { createUsageStore } from '../store/usage.js';
import type { AlertTag } from '../types.js';
import { dataQuality, queryAlertGroups } from './queries.js';
import type { DetailResponse, PoolResponse, StatsResponse } from './contracts.js';

const limitSchema = z.coerce.number().int().min(1).max(1000).default(200);
const sorts = ['lastAlertAt', 'symbol', 'ca', 'chain', 'marketCap', 'liquidity', 'volume24h', 'groupName', ...RPS_KEYS];
const sortSchema = z.string().default('-lastAlertAt').refine((value) => sorts.includes(value.replace(/^-/, '')));

export function createWebServer(opts: { db: StoreDatabase; cfg: StrategyConfig; now?: () => number; quotaTimezone?: string }) {
  const { db, cfg } = opts;
  const clock = opts.now ?? Date.now;
  return createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); send(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const raw = Object.fromEntries(url.searchParams);
      const now = clock();
      const timezone = opts.quotaTimezone ?? 'UTC';
      const poolStore = createPoolStore(db);
      const pools = poolStore.getPool().filter((row) => row.groupName?.split('、').some((g) => cfg.observeGroups.includes(g)));
      const updatedAt = pools.reduce((latest, row) => Math.max(latest, row.updatedAt), 0);
      if (url.pathname === '/api/stats') {
        const today = usageDate(now, timezone);
        const pushes = db.prepare(`SELECT ca, fired_at AS firedAt, COUNT(*) AS rows FROM alerts
          WHERE pushed = 1 AND fired_at >= ? AND fired_at <= ? GROUP BY ca, fired_at`)
          .all(now - 2 * INTERVAL_MS['1d'], now) as { ca: string; firedAt: number; rows: number }[];
        const body: StatsResponse = { poolSize: pools.length,
          alertsToday: pushes.filter((row) => usageDate(row.firedAt, timezone) === today)
            .reduce((sum, row) => sum + (cfg.alerting.mergeTagsPerCa ? 1 : row.rows), 0),
          quota: { used: createUsageStore(db).getUsage(today)?.calls ?? 0, limit: cfg.quota.dailyLimit },
          lastRunAt: updatedAt || null, dataQuality: dataQuality(db, cfg, now),
          refreshMinutes: cfg.schedule.mainLoopMinutes, quotaWarningPercent: cfg.quota.degradeAtPercent };
        send(200, body); return;
      }
      if (url.pathname === '/api/alerts') {
        const query = z.object({ ca: z.string().min(1).max(256).optional(),
          tag: z.string().refine((tag) => Object.hasOwn(TAG_DETAILS, tag)).optional(),
          from: z.coerce.number().int().nonnegative().optional(), to: z.coerce.number().int().nonnegative().optional(),
          limit: limitSchema }).refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to).parse(raw);
        send(200, queryAlertGroups(db, { ...query, ...(query.tag ? { tag: query.tag as AlertTag } : {}) } as Parameters<typeof queryAlertGroups>[1]));
        return;
      }
      if (url.pathname === '/api/pool') {
        const query = z.object({ chain: z.string().optional(), group: z.string().optional(), hit: z.enum(['0', '1']).optional(),
          sort: sortSchema, limit: limitSchema }).parse(raw);
        const quality = dataQuality(db, cfg, now);
        const inputs = readMarketInputs(db, cfg, now, quality.rpsAvailable);
        const lastAlerts = new Map((db.prepare('SELECT ca, MAX(fired_at) AS firedAt FROM alerts GROUP BY ca')
          .all() as { ca: string; firedAt: number }[]).map((row) => [row.ca, row.firedAt]));
        let items = inputs.map((input) => {
          const result = evaluate(input);
          return { ...poolStore.getPoolItem(input.ca)!, rpsScores: input.rpsScores, tags: result.tags,
            reasons: result.reasons, lastAlertAt: lastAlerts.get(input.ca) ?? null };
        }).filter((item) => (!query.chain || item.chain === query.chain)
          && (!query.group || item.groupName?.split('、').includes(query.group))
          && (query.hit === undefined || Boolean(item.tags.length) === (query.hit === '1')));
        const field = query.sort.replace(/^-/, '');
        const direction = query.sort.startsWith('-') ? -1 : 1;
        const value = (row: typeof items[number]): string | number | null => RPS_KEYS.includes(field as typeof RPS_KEYS[number])
          ? row.rpsScores[field as typeof RPS_KEYS[number]] : row[field as 'symbol' | 'marketCap' | 'lastAlertAt'];
        items.sort((a, b) => { const left = value(a); const right = value(b);
          if (left === null) return right === null ? a.ca.localeCompare(b.ca) : 1;
          if (right === null) return -1;
          return direction * (typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right)))
            || a.ca.localeCompare(b.ca); });
        const body: PoolResponse = { total: items.length, items: items.slice(0, query.limit), updatedAt };
        send(200, body); return;
      }
      const match = /^\/api\/ca\/([^/]+)$/.exec(url.pathname);
      if (match) {
        const ca = z.string().min(1).max(256).parse(decodeURIComponent(match[1]!));
        const query = z.object({ interval: z.enum(['30m', '60m', '4h']).default('30m'), limit: limitSchema }).parse(raw);
        const pool = poolStore.getPoolItem(ca);
        if (!pool) { send(404, { error: 'CA_NOT_FOUND' }); return; }
        const input = readMarketInputs(db, cfg, now, false).find((entry) => entry.ca === ca);
        if (!input) { send(404, { error: 'CA_NOT_OBSERVED' }); return; }
        const ms = PERIOD_MS[query.interval as Period];
        const all = closedCandles({ '30m': input.candles30m, '60m': input.candles60m, '4h': input.candles4h }[query.interval], ms, now);
        const recent = contiguousTail(all, ms);
        const displayed = all.slice(-query.limit);
        const start = displayed[0]?.openTime ?? Infinity;
        const body: DetailResponse = { pool, candles: displayed, moments: input.moments,
          indicators: {
            rsi: rsi(recent, cfg.indicators.rsiPeriod).map((value, i) => ({ openTime: recent[i + cfg.indicators.rsiPeriod]!.openTime, value }))
              .filter((point) => point.openTime >= start),
            volumeMa: sma(recent.map((bar) => bar.volume), cfg.supplementary.volMaPeriod)
              .map((value, i) => ({ openTime: recent[i + cfg.supplementary.volMaPeriod - 1]!.openTime, value }))
              .filter((point) => point.openTime >= start),
            parameters: { ...cfg.indicators, ...cfg.supplementary, maxRsi: cfg.pullback.maxRsi },
          }, alerts: queryAlertGroups(db, { ca, limit: query.limit }).items };
        send(200, body); return;
      }
      send(404, { error: 'NOT_FOUND' });
    } catch (error) {
      send(error instanceof z.ZodError || error instanceof URIError ? 400 : 500,
        { error: error instanceof z.ZodError || error instanceof URIError ? 'INVALID_QUERY' : 'INTERNAL_ERROR' });
    }
  });
}

async function main() {
  const { config } = await import('../config.js');
  const db = openDatabase(config.databasePath);
  const server = createWebServer({ db, cfg: loadStrategy(), quotaTimezone: config.quotaTimezone });
  server.listen(config.webPort, '127.0.0.1', () => console.log(`JSON API: http://127.0.0.1:${config.webPort}`));
  server.once('error', () => { db.close(); console.error('Web 服务启动失败'); process.exitCode = 1; });
  const stop = () => server.close(() => db.close());
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Web 启动失败，请检查配置'); process.exitCode = 1; });
}
