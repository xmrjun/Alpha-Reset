/** EVM 地址不区分大小写；Solana/Base58 地址保持原样。 */
export function canonicalCa(ca: string): string {
  return /^0x[\da-f]{40}$/i.test(ca) ? ca.toLowerCase() : ca;
}

/**
 * 形如 EVM 地址（0x 开头）但长度不合法的串。
 *
 * 群聊里会混入这类残缺地址，对它们请求行情必然失败，
 * 却照样消耗配额 —— 应在本地直接跳过。
 */
export function isMalformedEvmAddress(ca: string): boolean {
  return ca.startsWith('0x') && !/^0x[\da-f]{40}$/i.test(ca);
}

/** 能否作为行情查询的标的：排除空串与残缺 EVM 地址 */
export function isQueryableCa(ca: string): boolean {
  return ca.trim().length > 0 && !isMalformedEvmAddress(ca);
}
