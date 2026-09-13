import { canonicalCa } from '../addresses.js';
import { resolveGeckoNetwork } from '../api/networks.js';
import type { StrategyConfig } from '../config/strategy.js';
import { INTERVAL_MS } from '../market.js';
import type { StoreDatabase } from '../store/db.js';
import { createRuntimeStore, isRoundFresh, strategyKey, type RoundMember, type RoundSnapshot } from '../store/runtime.js';
import { createSeriesStore, isSupportedMarketSeries, type MarketSeries } from '../store/series.js';
import type { WebReadContext } from './read-context.js';
import type { DisplayRps, RpsDisplaySummary } from './contracts.js';

function network(member: RoundMember): string | null {
  const chain = member.pool.chain ?? member.dex?.chainId;
  return chain ? resolveGeckoNetwork(chain) : null;
}

/** 新名单立即可见；配置改变后不把旧观察池误认作新配置的结果。 */
export function latestObservationRound(db: StoreDatabase, cfg: StrategyConfig, context?: WebReadContext): RoundSnapshot | null {
  const runtime = context?.runtime ?? createRuntimeStore(db);
  const key = context?.key ?? strategyKey(cfg);
  const observation = runtime.getObservationRound();
  if (observation?.strategyKey === key && observation.boardComplete) return observation;
  const calculation = runtime.getRound();
  return calculation?.strategyKey === key && calculation.boardComplete ? calculation : null;
}

/** 页面可发现刚入库的活动序列；绝不认领 legacy，且不修改规则输入。 */
export function verifiedDisplaySeries(db: StoreDatabase, member: RoundMember, context?: WebReadContext): MarketSeries | null {
  const chain = network(member);
  if (!chain || member.seriesId === undefined) return null;
  const store = context?.series ?? createSeriesStore(db);
  const identity = store.getActive(chain, member.pool.ca);
  return identity?.active && identity.ca === canonicalCa(member.pool.ca) && identity.network === chain
    && isSupportedMarketSeries(identity) ? identity : null;
}

/** 固定 T 只读其原 seriesId；后续 active 变化不能改写原计算来源。 */
export function verifiedCalculationSeries(db: StoreDatabase, member: RoundMember, context?: WebReadContext): MarketSeries | null {
  const chain = network(member);
  if (!chain || !member.seriesId) return null;
  const identity = (context?.series ?? createSeriesStore(db)).getSeries(member.seriesId);
  return identity?.ca === canonicalCa(member.pool.ca) && identity.network === chain
    && isSupportedMarketSeries(identity) ? identity : null;
}

/** 已完成评分与正在采集的快照分开；返回值仅用于界面。 */
export function readRpsDisplay(db: StoreDatabase, cfg: StrategyConfig, now: number, context?: WebReadContext) {
  const runtime = context?.runtime ?? createRuntimeStore(db);
  const current = runtime.getRound();
  const saved = runtime.getRpsRound();
  const byCa = new Map<string, DisplayRps>();
  if (!saved || saved.strategyKey !== strategyKey(cfg) || saved.completedAt === null
    || !saved.boardComplete || !['complete', 'partial'].includes(saved.status)
    || saved.rpsFromPreviousRound || saved.completedAt > now || saved.startedAt > now) {
    return { summary: null, byCa };
  }
  const summary: RpsDisplaySummary = {
    state: !isRoundFresh(saved, cfg, now) ? 'stale'
      : current?.startedAt === saved.startedAt && current.strategyKey === saved.strategyKey
        && ['complete', 'partial'].includes(current.status) ? 'current' : 'previous',
    asOf: Math.floor(saved.startedAt / INTERVAL_MS['15m']) * INTERVAL_MS['15m'],
    computedAt: saved.completedAt, poolSize: saved.members.length, coverage: saved.coverage,
  };
  const observation = latestObservationRound(db, cfg, context);
  if (!observation) return { summary, byCa };
  const calculated = new Map(current?.strategyKey === saved.strategyKey ? current.members.map((member) => [canonicalCa(member.pool.ca), member]) : []);
  const old = new Map(saved.members.map((member) => [canonicalCa(member.pool.ca), member]));
  for (const member of observation.members) {
    const ca = canonicalCa(member.pool.ca);
    const computed = calculated.get(ca);
    if (!computed) continue;
    const identity = verifiedDisplaySeries(db, member, context);
    if (!identity) continue;
    const computedIdentity = verifiedCalculationSeries(db, computed, context);
    // 等待新 T 的 GMGN 首次绑定时，旧值仍只能来自当前 active Gecko 同一序列。
    const awaitingGmgn = computed.seriesId === null && computed.plannedSource === 'gmgn'
      && identity.source === 'geckoterminal' && network(computed) === identity.network;
    if (!awaitingGmgn && computedIdentity?.id !== identity.id) continue;
    let previous = old.get(ca);
    let sourceRound = saved;
    let sourcePoolSize = saved.members.length;
    if (awaitingGmgn && (previous?.seriesId !== identity.id || !current || saved.startedAt >= current.startedAt)) {
      const fallback = runtime.getRpsFallbackRound(identity.id);
      if (!fallback || fallback.strategyKey !== strategyKey(cfg) || !fallback.boardComplete
        || fallback.completedAt === null || !['complete', 'partial'].includes(fallback.status)
        || fallback.rpsFromPreviousRound || fallback.completedAt > now || fallback.startedAt > now) continue;
      sourceRound = fallback;
      sourcePoolSize = fallback.originalPoolSize;
      previous = fallback.members.find(item => canonicalCa(item.pool.ca) === ca);
    }
    if (previous?.seriesId !== identity.id || network(previous) !== identity.network
      || (awaitingGmgn && (!current || sourceRound.startedAt >= current.startedAt))) continue;
    const sourceSummary = sourceRound === saved ? summary : {
      state: isRoundFresh(sourceRound, cfg, now) ? 'previous' as const : 'stale' as const,
      asOf: Math.floor(sourceRound.startedAt / INTERVAL_MS['15m']) * INTERVAL_MS['15m'],
      computedAt: sourceRound.completedAt!, poolSize: sourcePoolSize,
    };
    byCa.set(ca, {
      state: sourceSummary.state, asOf: sourceSummary.asOf, computedAt: sourceSummary.computedAt,
      poolSize: sourcePoolSize, source: identity.source === 'gmgn' ? 'gmgn' : 'geckoterminal', scores: previous.rpsScores,
      ...((previous.rpsDisplayBounds ?? previous.rpsBounds)
        ? { bounds: previous.rpsDisplayBounds ?? previous.rpsBounds! } : {}),
    });
  }
  return { summary, byCa };
}
