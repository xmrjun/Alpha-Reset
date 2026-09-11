export type Interval = '15m' | '1h' | '4h' | '1d';
export type Range    = '24h' | '7d' | '30d' | '90d';

export interface Candle {
  openTime: number; open: number; high: number;
  low: number; close: number; volume: number;
}

export interface PoolItem {
  ca: string; symbol: string | null; chain: string | null;
  marketCap: number | null; liquidity: number | null;
  volume24h: number | null; groupName: string | null;
  latestMentionTime: number | null;
}

/** board 的排名元数据；null 表示未提供，不能当作零参与 Top N。 */
export interface BoardPoolItem extends PoolItem {
  totalMentions: number | null;
}

export interface DexSnapshot {
  /** 主交易对地址与所在网络：GeckoTerminal 拉 K 线需要它们定位 pool */
  pairAddress: string | null;
  chainId: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  priceChange: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  pairCreatedAt: number | null;
}

/** A3 的六个时刻 */
export type MomentId = 1 | 2 | 3 | 4 | 5 | 6;

export interface BreakoutMoment {
  moment: MomentId; barTime: number; price: number;
}

export type AlertTag =
  | '30m_ath_pullback'      // 【30分钟历史新高回调提醒】
  | '30m_1d_high_pullback'  // 【30分钟一日新高回调】
  | '60m_ath_pullback'      // 【60分钟历史新高回调】
  | '60m_2d_high_pullback'  // 【60分钟两日新高回调】
  | '4h_ath_pullback'       // 【4小时历史新高回调】
  | '4h_8d_high_pullback'   // 【4小时八日新高回调】
  | 'low_vol_30m' | 'low_vol_60m' | 'low_vol_4h'
  | 'rsi_lt50_30m' | 'rsi_lt50_60m' | 'rsi_lt50_4h';
