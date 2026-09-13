/** DexScreener 与 GeckoTerminal 使用不同的网络 ID；只映射已确认的别名。 */
const geckoNetworkAliases: Readonly<Record<string, string>> = {
  ethereum: 'eth',
  avalanche: 'avax',
  xlayer: 'x-layer',
};

export function resolveGeckoNetwork(chain: string): string {
  const network = chain.trim();
  return Object.hasOwn(geckoNetworkAliases, network) ? geckoNetworkAliases[network]! : network;
}
