import { canonicalCa } from '../addresses.js';
import type { StrategyConfig } from '../config/strategy.js';
import { merge15mTo30m } from '../indicators/merge.js';
import { INTERVAL_MS, closedCandles, emptyScores } from '../market.js';
import type { RuleInput } from '../rules/evaluate.js';
import type { BreakoutMoment, Candle, Interval } from '../types.js';
import { createCandleStore } from './candles.js';
import { createMomentStore } from './moments.js';
import { createPoolStore, type PoolRow } from './pool.js';
import { createRuntimeStore, isRoundFresh, pendingMember, strategyKey, type RoundMember } from './runtime.js';
import type { StoreDatabase } from './db.js';

export interface ObservationInput extends RuleInput { pool: PoolRow; candles15m: Candle[] }

/** 旧大小写别名的历史合并读取；规范地址上的新版本优先，不删除历史行。 */
export function readRoundInputs(db: StoreDatabase, cfg: StrategyConfig, now: number, members: RoundMember[]): ObservationInput[] {
  const candles = createCandleStore(db);
  const moments = createMomentStore(db);
  const archives = createPoolStore(db).getPool();
  return members.map((member) => {
    const ca = canonicalCa(member.pool.ca);
    const aliases = [...new Set([...archives.filter((row) => canonicalCa(row.ca) === ca).map((row) => row.ca), ca])]
      .sort((a, b) => Number(a === ca) - Number(b === ca) || a.localeCompare(b));
    const history = (interval: Interval): Candle[] => {
      const byTime = new Map<number, Candle>();
      for (const address of aliases) for (const bar of candles.getCandles(address, interval)) byTime.set(bar.openTime, bar);
      return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
    };
    const recorded = new Map<number, BreakoutMoment>();
    for (const address of aliases) for (const moment of moments.getMoments(address)) {
      const old = recorded.get(moment.moment);
      if (!old || old.barTime < moment.barTime || (old.barTime === moment.barTime && old.price < moment.price)) recorded.set(moment.moment, moment);
    }
    const candles15m = history('15m');
    return { ca, now, cfg, pool: { ...member.pool, ca }, listedAt: member.pool.listedAt, candles15m,
      candles30m: merge15mTo30m(closedCandles(candles15m, INTERVAL_MS['15m'], now)),
      candles60m: history('1h'), candles4h: history('4h'),
      moments: [...recorded.values()].sort((a, b) => a.moment - b.moment), rpsScores: member.rpsScores };
  });
}

export function readMarketInputs(db: StoreDatabase, cfg: StrategyConfig, now: number, allowRps = true): ObservationInput[] {
  const round = createRuntimeStore(db).getRound();
  if (!round || round.strategyKey !== strategyKey(cfg)) return [];
  const inputs = readRoundInputs(db, cfg, now, round.members);
  if (!allowRps || !isRoundFresh(round, cfg, now)) for (const input of inputs) input.rpsScores = emptyScores();
  return inputs;
}

export function readArchivedInput(db: StoreDatabase, cfg: StrategyConfig, now: number, ca: string): ObservationInput | null {
  const state = createRuntimeStore(db);
  const round = state.getRound();
  const current = round?.members.find((member) => canonicalCa(member.pool.ca) === canonicalCa(ca));
  const pool = current?.pool ?? createPoolStore(db).getPool().find((row) => canonicalCa(row.ca) === canonicalCa(ca));
  if (!pool) return null;
  const member = current ?? pendingMember({ ...pool, listedAt: state.getListing(ca) }, 0);
  return readRoundInputs(db, cfg, now, [member])[0] ?? null;
}
