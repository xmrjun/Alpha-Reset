import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { canonicalCa } from '../addresses.js';
import { resolveGeckoNetwork } from '../api/networks.js';
import { loadStrategy, type StrategyConfig } from '../config/strategy.js';
import { rsi } from '../indicators/rsi.js';
import { sma } from '../indicators/sma.js';
import { INTERVAL_MS, PERIOD_MS, RPS_KEYS, TAG_DETAILS, closedCandles, contiguousTail, emptyScores, type Period } from '../market.js';
import { checkPreconditions } from '../rules/preconditions.js';
import { usageDate } from '../scheduler/quota.js';
import { openDatabase, type StoreDatabase } from '../store/db.js';
import { isRoundFresh, strategyKey } from '../store/runtime.js';
import { readRoundInputs } from '../store/snapshot.js';
import { createUsageStore } from '../store/usage.js';
import type { AlertTag } from '../types.js';
import { dataQuality, queryAlertGroups, queryOutcomes } from './queries.js';
import { latestObservationRound, readRpsDisplay, verifiedDisplaySeries, verifiedCalculationSeries } from './rps-display.js';
import { createWebReadModel, type WebReadContext } from './read-context.js';
import { attachLiveFeed } from './live.js';
import type { DetailResponse, PoolResponse, StatsResponse } from './contracts.js';

const limitSchema = z.coerce.number().int().min(1).max(1000).default(200);
const sorts = ['lastAlertAt', 'symbol', 'ca', 'chain', 'marketCap', 'liquidity', 'volume24h', 'groupName', ...RPS_KEYS];
const sortSchema = z.string().default('-lastAlertAt').refine((value) => sorts.includes(value.replace(/^-/, '')));

export function createWebServer(opts: { db: StoreDatabase; cfg: StrategyConfig; now?: () => number; quotaTimezone?: string; liveIntervalMs?: number }) {
  const { db, cfg } = opts;
  const clock = opts.now ?? Date.now;
  const reads = createWebReadModel(db, cfg);
  function statsAt(now: number, context = reads.readContext()): StatsResponse {
    const timezone = opts.quotaTimezone ?? 'UTC';
    const quality = dataQuality(db, cfg, now, context);
    const today = usageDate(now, timezone);
    const pushes = db.prepare(`SELECT ca, fired_at AS firedAt, COUNT(*) AS rows FROM alerts
      WHERE pushed = 1 AND fired_at >= ? AND fired_at <= ? GROUP BY ca, fired_at`)
      .all(now - 2 * INTERVAL_MS['1d'], now) as { ca: string; firedAt: number; rows: number }[];
    const body: StatsResponse = { poolSize: quality.observation.memberCount,
      alertsToday: pushes.filter((row) => usageDate(row.firedAt, timezone) === today)
        .reduce((sum, row) => sum + (cfg.alerting.mergeTagsPerCa ? 1 : row.rows), 0),
      quota: { used: createUsageStore(db).getUsage(today)?.calls ?? 0, limit: cfg.quota.dailyLimit },
      lastRunAt: quality.observation.updatedAt, dataQuality: quality,
      refreshMinutes: cfg.schedule.mainLoopMinutes, revisionMinutes: cfg.schedule.revisionMinutes ?? 3, quotaWarningPercent: cfg.quota.degradeAtPercent,
        rpsMinCoverage: cfg.a4_rps.minCoverage, inactiveAfterBars: cfg.a4_rps.inactiveAfterBars };
    return body;
  }
  function poolAt(now: number, query: { chain?: string | undefined; group?: string | undefined; hit?: '0' | '1' | undefined; sort: string; limit: number }, context: WebReadContext = reads.readContext()): PoolResponse {
    const observation = latestObservationRound(db, cfg, context);
    const stored = context.runtime.getRound();
    const calculation = stored?.strategyKey === strategyKey(cfg) ? stored : null;
    const updatedAt = observation ? observation.observedAt ?? observation.completedAt ?? observation.startedAt : 0;
    const calculated = new Map(calculation?.members.map((member) => [canonicalCa(member.pool.ca), member]));
    const display = readRpsDisplay(db, cfg, now, context);
    const lastAlerts = new Map((db.prepare('SELECT ca, MAX(fired_at) AS firedAt FROM alerts GROUP BY ca')
      .all() as { ca: string; firedAt: number }[]).map((row) => [row.ca, row.firedAt]));
    let items = (observation?.members ?? []).map((member) => {
      const ca = canonicalCa(member.pool.ca);
      const previous = calculated.get(ca);
      const currentIdentity = verifiedDisplaySeries(db, member, context);
      const priorIdentity = previous ? verifiedCalculationSeries(db, previous, context) : null;
      const chain = member.pool.chain ?? member.dex?.chainId;
      const priorChain = previous?.pool.chain ?? previous?.dex?.chainId;
      const sameNetwork = Boolean(chain && priorChain && resolveGeckoNetwork(chain) === resolveGeckoNetwork(priorChain));
      // undefined 仅兼容同一旧快照；新发现名单不能把 legacy 历史认领为固定池行情。
      const sameLegacySnapshot = member.seriesId === undefined && previous?.seriesId === undefined
        && observation?.startedAt === calculation?.startedAt;
      const matches = Boolean(previous && sameNetwork && (sameLegacySnapshot
        || (currentIdentity && priorIdentity && previous.seriesId === priorIdentity.id && currentIdentity.id === priorIdentity.id)));
      const fresh = matches && isRoundFresh(calculation, cfg, now);
      const result = fresh ? previous?.result : null;
      // 旧离线快照可能仅有 RPS 而未保存 result；只解释已有分数，不从行情重新计算或生成标签。
      const legacyReasons = fresh && sameLegacySnapshot && previous && !result ? {
        ...checkPreconditions({ pool: previous.pool, listedAt: previous.pool.listedAt, now: calculation!.startedAt }, cfg),
        a3: false,
        a4: RPS_KEYS.some(key => {
          const score = previous.rpsScores[key]; const bound = previous.rpsBounds?.[key];
          return (score !== null && Number.isFinite(score) && score > cfg.a4_rps.periods[key].threshold)
            || Boolean(bound && (bound.status === 'pass' || bound.status === 'exact')
              && Number.isFinite(bound.lower) && Number.isFinite(bound.upper) && bound.lower >= 0
              && bound.upper <= 100 && bound.lower <= bound.upper && bound.lower > cfg.a4_rps.periods[key].threshold);
        }),
      } : null;
      // 名单以最新完整发现为准；已有计算保留当时的身份/规模，不能从 ca_pool 归档覆盖。
      return { ...(matches && previous ? { ...previous.pool, ca } : { ...member.pool, ca }),
        scoreSource: matches && (priorIdentity?.source === 'gmgn' || priorIdentity?.source === 'geckoterminal') ? priorIdentity.source : null,
        rpsScores: fresh && previous ? previous.rpsScores : emptyScores(),
        displayRps: display.byCa.get(ca) ?? null, calculationPending: !matches,
        ...(fresh && previous?.rpsBounds ? { rpsBounds: previous.rpsBounds } : {}), tags: result?.tags ?? [],
        reasons: result?.reasons ?? legacyReasons ?? { a1: false, a2: false, a3: false, a4: false },
        lastAlertAt: matches ? lastAlerts.get(ca) ?? null : null };
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
    return body;
  }
  const server = createServer((request, response) => {
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
      if (url.pathname === '/api/stats') {
        send(200, db.transaction(() => statsAt(now))()); return;
      }
      if (url.pathname === '/api/alerts') {
        const query = z.object({ ca: z.string().min(1).max(256).optional(),
          tag: z.string().refine((tag) => Object.hasOwn(TAG_DETAILS, tag)).optional(),
          from: z.coerce.number().int().nonnegative().optional(), to: z.coerce.number().int().nonnegative().optional(),
          limit: limitSchema }).refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to).parse(raw);
        send(200, queryAlertGroups(db, { ...query, ...(query.tag ? { tag: query.tag as AlertTag } : {}) } as Parameters<typeof queryAlertGroups>[1]));
        return;
      }
      if (url.pathname === '/api/outcomes') {
        const query = z.object({ since: z.coerce.number().int().nonnegative().optional() }).parse(raw);
        send(200, db.transaction(() => queryOutcomes(db, query.since ?? 0))()); return;
      }
      if (url.pathname === '/api/pool') {
        const query = z.object({ chain: z.string().optional(), group: z.string().optional(), hit: z.enum(['0', '1']).optional(),
          sort: sortSchema, limit: limitSchema }).parse(raw);
        send(200, db.transaction(() => poolAt(now, query))()); return;
      }
      const match = /^\/api\/ca\/([^/]+)$/.exec(url.pathname);
      if (match) {
        const ca = z.string().min(1).max(256).parse(decodeURIComponent(match[1]!));
        const query = z.object({ interval: z.enum(['30m', '60m', '4h']).default('30m'), limit: limitSchema }).parse(raw);
        const context = reads.readContext();
        const member = latestObservationRound(db, cfg, context)?.members.find(entry => canonicalCa(entry.pool.ca) === canonicalCa(ca));
        if (!member) { send(404, { error: 'CA_NOT_OBSERVED' }); return; }
        const identity = verifiedDisplaySeries(db, member, context);
        const currentMember = { ...member, rpsScores: emptyScores() };
        delete currentMember.rpsBounds; delete currentMember.rpsDisplayBounds;
        if (member.seriesId !== undefined) currentMember.seriesId = identity?.id ?? null;
        const input = readRoundInputs(db, cfg, now, [currentMember])[0]!;
        const pool = input.pool;
        const ms = PERIOD_MS[query.interval as Period];
        const all = closedCandles({ '30m': input.candles30m, '60m': input.candles60m, '4h': input.candles4h }[query.interval], ms, now);
        const recent = contiguousTail(all, ms);
        const displayed = all.slice(-query.limit);
        const start = displayed[0]?.openTime ?? Infinity;
        const body: DetailResponse = { pool, candles: displayed, moments: input.moments,
          marketSeries: identity, historyStartedAt: all[0]?.openTime ?? null,
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
  attachLiveFeed({ server, db, readVersion: () => reads.readVersion(clock()), ...(opts.liveIntervalMs ? { intervalMs: opts.liveIntervalMs } : {}),
    readSnapshot: () => { const now = clock(); const context = reads.readContext(); return { stats: statsAt(now, context), pool: poolAt(now, { sort: '-lastAlertAt', limit: 1000 }, context) }; } });
  return server;
}

async function main() {
  const { config } = await import('../config.js');
  const db = openDatabase(config.databasePath);
  const server = createWebServer({ db, cfg: loadStrategy(), quotaTimezone: config.quotaTimezone });
  server.listen(config.webPort, '127.0.0.1', () => console.log(`JSON API: http://127.0.0.1:${config.webPort}`));
  server.once('error', () => { db.close(); console.error('Web 服务启动失败'); process.exitCode = 1; });
  const stop = () => { server.emit('shutdown'); server.close(() => db.close()); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Web 启动失败，请检查配置'); process.exitCode = 1; });
}
