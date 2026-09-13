import { canonicalCa } from '../addresses.js';
import { resolveGeckoNetwork } from '../api/networks.js';
import type { StrategyConfig } from '../config/strategy.js';
import { merge15mTo30m } from '../indicators/merge.js';
import { INTERVAL_MS, closedCandles, emptyScores } from '../market.js';
import type { RuleInput } from '../rules/evaluate.js';
import type { BreakoutMoment, Candle, Interval } from '../types.js';
import { createCandleStore } from './candles.js';
import { createMomentStore } from './moments.js';
import { createSeriesStore, isSupportedMarketSeries } from './series.js';
import { createPoolStore, type PoolRow } from './pool.js';
import { createRuntimeStore, isRoundFresh, pendingMember, strategyKey, type RoundMember } from './runtime.js';
import type { StoreDatabase } from './db.js';

export interface ObservationInput extends RuleInput { pool: PoolRow; candles15m: Candle[] }

/** 只有旧离线快照的 undefined 读取 legacy；null 或无效序列严格返回空数据。 */
export function readRoundInputs(db: StoreDatabase, cfg: StrategyConfig, now: number, members: RoundMember[]): ObservationInput[] {
  const candles = createCandleStore(db);
  const moments = createMomentStore(db);
  const series = createSeriesStore(db);
  const archives = createPoolStore(db).getPool();
  return members.map((member) => {
    const ca = canonicalCa(member.pool.ca);
    let history: (interval: Interval) => Candle[];
    let recorded: BreakoutMoment[];
    if (member.seriesId === undefined) {
      // 旧地址大小写别名仅用于显式 legacy 兼容；不得合并进新序列。
      const aliases = [...new Set([...archives.filter((row) => canonicalCa(row.ca) === ca).map((row) => row.ca), ca])]
        .sort((a, b) => Number(a === ca) - Number(b === ca) || a.localeCompare(b));
      history = (interval: Interval): Candle[] => {
        const byTime = new Map<number, Candle>();
        for (const address of aliases) for (const bar of candles.getCandles(address, interval)) byTime.set(bar.openTime, bar);
        return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
      };
      const byMoment = new Map<number, BreakoutMoment>();
      for (const address of aliases) for (const moment of moments.getMoments(address)) {
        const old = byMoment.get(moment.moment);
        if (!old || old.barTime < moment.barTime || (old.barTime === moment.barTime && old.price < moment.price)) byMoment.set(moment.moment, moment);
      }
      recorded = [...byMoment.values()].sort((a, b) => a.moment - b.moment);
    } else {
      const identity = member.seriesId === null ? null : series.getSeries(member.seriesId);
      const valid = isSupportedMarketSeries(identity) && identity.ca === ca && identity.network === memberNetwork(member);
      history = (interval: Interval): Candle[] => valid ? series.getCandles(identity!.id, interval).reverse() : [];
      recorded = valid ? series.getMoments(identity!.id) : [];
    }
    const candles15m = history('15m');
    return { ca, now, cfg, pool: { ...member.pool, ca }, listedAt: member.pool.listedAt, candles15m,
      candles30m: merge15mTo30m(closedCandles(candles15m, INTERVAL_MS['15m'], now)),
      candles60m: history('1h'), candles4h: history('4h'),
      moments: recorded, rpsScores: member.rpsScores,
      ...(member.rpsBounds ? { rpsBounds: member.rpsBounds } : {}) };
  });
}

function memberNetwork(member: RoundMember): string | null {
  const chain = member.pool.chain ?? member.dex?.chainId;
  if (!chain) return null;
  try { return resolveGeckoNetwork(chain); } catch { return null; }
}

export function readMarketInputs(db: StoreDatabase, cfg: StrategyConfig, now: number, allowRps = true): ObservationInput[] {
  const runtime = createRuntimeStore(db);
  const calculated = runtime.getRound();
  const observed = runtime.getObservationRound();
  const round = calculated?.strategyKey === strategyKey(cfg) ? calculated
    : observed?.strategyKey === strategyKey(cfg) ? observed : null;
  if (!round) return [];
  // 当前标签与RPS使用同一计算时点；详情allowRps=false仍可查看持续入库的新K线。
  const inputs = readRoundInputs(db, cfg, allowRps ? round.startedAt : now, round.members);
  if (!allowRps || !isRoundFresh(round, cfg, now)) for (const input of inputs) {
    input.rpsScores = emptyScores();
    delete input.rpsBounds;
  }
  return inputs;
}

/** 最新动态观察池的只读行情；绝不把发现名单变更直接带入本次固定 T 的评分。 */
export function readObservationInputs(db: StoreDatabase, cfg: StrategyConfig, now: number): ObservationInput[] {
  const runtime = createRuntimeStore(db);
  const observed = runtime.getObservationRound();
  const calculated = runtime.getRound();
  const key = strategyKey(cfg);
  const round = observed?.boardComplete && observed.strategyKey === key ? observed
    : calculated?.boardComplete && calculated.strategyKey === key ? calculated : null;
  if (!round) return [];
  const series = createSeriesStore(db);
  const members = round.members.map((original) => {
    const member = { ...original, rpsScores: emptyScores() };
    delete member.rpsBounds;
    delete member.rpsDisplayBounds;
    if (member.seriesId !== undefined) {
      const network = memberNetwork(member);
      const active = network ? series.getActive(network, member.pool.ca) : null;
      member.seriesId = isSupportedMarketSeries(active) ? active.id : null;
    }
    return member;
  });
  return readRoundInputs(db, cfg, now, members);
}

export function readArchivedInput(db: StoreDatabase, cfg: StrategyConfig, now: number, ca: string): ObservationInput | null {
  const state = createRuntimeStore(db);
  const round = state.getRound();
  const current = round?.members.find((member) => canonicalCa(member.pool.ca) === canonicalCa(ca));
  const pool = current?.pool ?? createPoolStore(db).getPool().find((row) => canonicalCa(row.ca) === canonicalCa(ca));
  if (!pool) return null;
  const member = current ?? pendingMember({ ...pool, listedAt: state.getListing(ca) }, 0);
  const network = memberNetwork(member);
  const active = network === null ? null : createSeriesStore(db).getActive(network, canonicalCa(ca));
  return readRoundInputs(db, cfg, now, [active ? { ...member, seriesId: active.id } : member])[0] ?? null;
}
