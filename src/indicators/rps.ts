/** 一基竞争排名（1, 1, 3）；并列同分；无效涨幅不进入排名分母。 */
export function rps(changes: Map<string, number>): Map<string, number> {
  const sorted = [...changes].filter(([, change]) => Number.isFinite(change))
    .sort((a, b) => b[1] - a[1]);
  const scores = new Map<string, number>();
  let rank = 1;
  for (let i = 0; i < sorted.length; i++) {
    const [ca, change] = sorted[i]!;
    if (i > 0 && change !== sorted[i - 1]![1]) rank = i + 1;
    scores.set(ca, (1 - rank / sorted.length) * 100);
  }
  return scores;
}
