import type { Candle, PoolItem, BoardPoolItem } from '../src/types.js';

export function candle(openTime: number, close = 10, overrides: Partial<Candle> = {}): Candle {
  return { openTime, open: close, high: close, low: close, close, volume: 100, ...overrides };
}

export function poolItem(ca = 'test-ca', overrides: Partial<PoolItem> = {}): PoolItem {
  return { ca, symbol: 'TEST', chain: 'solana', marketCap: 100_000,
    liquidity: 50_000, volume24h: 10_000, groupName: '镭射猫聊天',
    latestMentionTime: null, ...overrides };
}

/** 看板条目比入库的 PoolItem 多一个用于 Top N 排序的 totalMentions */
export function boardPoolItem(ca = 'test-ca', overrides: Partial<BoardPoolItem> = {}): BoardPoolItem {
  return { ...poolItem(ca), totalMentions: 1, ...overrides };
}
