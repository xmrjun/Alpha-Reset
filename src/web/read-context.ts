import { canonicalCa } from '../addresses.js';
import { resolveGeckoNetwork } from '../api/networks.js';
import type { StrategyConfig } from '../config/strategy.js';
import { INTERVAL_MS } from '../market.js';
import type { StoreDatabase } from '../store/db.js';
import { createRuntimeStore, strategyKey, type RoundMember } from '../store/runtime.js';
import type { MarketSeries } from '../store/series.js';

export interface WebReadContext {
  key: string;
  runtime: ReturnType<typeof createRuntimeStore>;
  series: { getSeries(id: string): MarketSeries | null; getActive(network: string, ca: string): MarketSeries | null };
  hasEndpoint(member: RoundMember, openTime: number): boolean;
}
const memberNetwork = (member: RoundMember) => resolveGeckoNetwork(member.pool.chain ?? member.dex?.chainId ?? '');
const activeKey = (network: string, ca: string) => JSON.stringify([network, canonicalCa(ca)]);

/** 单 Web 服务拥有的只读缓存。数据库任意写入只触发轻量比较，历史 K 线变化不会直接重建列表。 */
export function createWebReadModel(db: StoreDatabase, cfg: StrategyConfig) {
  let payloads = new Map<string, string>();
  let byId = new Map<string, MarketSeries>();
  let active = new Map<string, MarketSeries>();
  let endpoints = new Map<string, boolean>();
  let databaseVersion = '';
  let identityVersion = '';
  let auxiliaryVersion = '';
  let endpointVersion = '';
  let version = 0;
  let freshnessBoundaries: number[] = [];
  const runtime = createRuntimeStore(db, Date.now, undefined, { payload: key => payloads.get(key), cacheParsed: true });
  const relevant = db.prepare("SELECT key, payload FROM runtime_state WHERE key IN ('last_round','last_rps_round','collection_round','observation_round','discovery_round','gmgn_status','gmgn_cooldown','binance_status','binance_cooldown') OR key LIKE 'rps_fallback:%' ORDER BY key");
  const readIdentities = db.prepare(`SELECT id,source,scope,network,ca,pool_address AS poolAddress,currency,
    format_version AS formatVersion,created_at AS createdAt,activated_at AS activatedAt,active FROM market_series ORDER BY id`);
  const changes = db.prepare('SELECT total_changes() AS value');
  const alertVersion = db.prepare('SELECT id,ca,fired_at,pushed FROM alerts ORDER BY id');
  const usageVersion = db.prepare('SELECT date,calls,updated_at FROM api_usage ORDER BY date');
  const seriesEndpoint = db.prepare("SELECT 1 FROM series_candles WHERE series_id=? AND interval='15m' AND open_time=?");
  const legacyEndpoint = db.prepare("SELECT 1 FROM candles WHERE ca=? AND interval='15m' AND open_time=?");
  const endpointKey = (member: RoundMember, openTime: number) => member.seriesId === undefined
    ? JSON.stringify(['legacy', member.pool.ca, openTime])
    : JSON.stringify(['series', active.get(activeKey(memberNetwork(member), member.pool.ca))?.id ?? null, openTime]);
  const context: WebReadContext = {
    key: strategyKey(cfg), runtime,
    series: { getSeries: id => byId.get(id) ?? null, getActive: (network, ca) => active.get(activeKey(network, ca)) ?? null },
    hasEndpoint: (member, openTime) => endpoints.get(endpointKey(member, openTime)) ?? false,
  };
  function refresh(): void {
    const revision = db.pragma('data_version', { simple: true }) + ':' + (changes.get() as { value: number }).value;
    const key = strategyKey(cfg);
    if (revision === databaseVersion && context.key === key) return;
    let changed = key !== context.key;
    context.key = key;
    const next = new Map((relevant.all() as { key: string; payload: string }[]).map(row => [row.key, row.payload]));
    if (next.size !== payloads.size || [...next].some(([name, payload]) => payloads.get(name) !== payload)) changed = true;
    payloads = next;
    const identities = readIdentities.all() as Array<Omit<MarketSeries, 'active'> & { active: number }>;
    const identityStamp = JSON.stringify(identities);
    if (identityStamp !== identityVersion) {
      changed = true; identityVersion = identityStamp;
      const rows = identities.map(row => ({ ...row, active: row.active === 1 }) as MarketSeries);
      byId = new Map(rows.map(row => [row.id, row]));
      active = new Map(rows.filter(row => row.active).map(row => [activeKey(row.network, row.ca), row]));
    }
    const auxiliaryStamp = JSON.stringify([alertVersion.all(), usageVersion.all()]);
    if (auxiliaryStamp !== auxiliaryVersion) { changed = true; auxiliaryVersion = auxiliaryStamp; }
    const calculated = runtime.getRound();
    const collecting = runtime.getCollectionRound();
    const round = collecting?.strategyKey === key ? collecting : calculated?.strategyKey === key ? calculated : null;
    const expected = round ? Math.floor(round.startedAt / INTERVAL_MS['15m']) * INTERVAL_MS['15m'] - INTERVAL_MS['15m'] : null;
    const nextEndpoints = new Map<string, boolean>();
    if (expected !== null) for (const member of round!.members) {
      const endpoint = endpointKey(member, expected);
      if (nextEndpoints.has(endpoint)) continue;
      const identity = active.get(activeKey(memberNetwork(member), member.pool.ca));
      nextEndpoints.set(endpoint, member.seriesId === undefined ? Boolean(legacyEndpoint.get(member.pool.ca, expected))
        : Boolean(identity && seriesEndpoint.get(identity.id, expected)));
    }
    const endpointStamp = JSON.stringify([...nextEndpoints]);
    if (endpointStamp !== endpointVersion) { changed = true; endpointVersion = endpointStamp; }
    endpoints = nextEndpoints;
    const timed = [calculated, runtime.getRpsRound(), ...[...payloads.keys()]
      .filter(name => name.startsWith('rps_fallback:')).map(name => runtime.getRpsFallbackRound(name.slice('rps_fallback:'.length)))];
    freshnessBoundaries = [...new Set(timed.flatMap(round => round ? [round.startedAt,
      ...(round.completedAt === null ? [] : [round.completedAt, round.completedAt + cfg.schedule.mainLoopMinutes * 60_000])] : []))].sort((a, b) => a - b);
    databaseVersion = revision;
    if (changed) version++;
  }
  return {
    /** 必须在读事务内调用，stats/pool 共用此上下文且不修改缓存对象。 */
    readContext(): WebReadContext { refresh(); return context; },
    /** 即使没有写入，也定期重评过期/自然日状态；不扫描行情历史。 */
    readVersion(now: number): string { refresh(); return `${version}:${Math.floor(now / 15_000)}:${freshnessBoundaries.filter(time => time <= now).length}`; },
  };
}
