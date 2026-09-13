/**
 * 外部行情站链接。
 *
 * DexScreener：已从它拿到 pairAddress 与 chainId（见后端 dexscreener 客户端），
 * 有交易对地址时直达，否则退回搜索页。
 *
 * GMGN：链标识与上游的 chain 命名不完全一致（它用 sol / eth，
 * 而 DexScreener 给的是 solana / ethereum），所以已知的做映射。
 * 未列出的链直接透传原值 —— GMGN 的覆盖面在持续扩张，
 * 与其因为没收录而不给链接，不如生成出来让用户自己点。
 */
const GMGN_CHAIN: Record<string, string> = {
  solana: 'sol',
  ethereum: 'eth',
  eth: 'eth',
  bsc: 'bsc',
  bnb: 'bsc',
  base: 'base',
  tron: 'tron',
  avalanche: 'avax',
  arbitrum: 'arb',
  polygon: 'polygon',
  blast: 'blast',
};

export function dexScreenerUrl(ca: string, chain?: string | null, pair?: string | null): string {
  return chain && pair
    ? `https://dexscreener.com/${encodeURIComponent(chain)}/${encodeURIComponent(pair)}`
    : `https://dexscreener.com/search?q=${encodeURIComponent(ca)}`;
}

export function gmgnUrl(ca: string, chain?: string | null): string | null {
  if (!chain) return null;
  const slug = GMGN_CHAIN[chain] ?? chain;
  return `https://gmgn.ai/${encodeURIComponent(slug)}/token/${encodeURIComponent(ca)}`;
}
