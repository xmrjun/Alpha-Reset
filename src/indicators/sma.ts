/** 结果首项对应输入的 period - 1 索引，不填充前导零。 */
export function sma(values: number[], period: number): number[] {
  if (!Number.isSafeInteger(period) || period < 1) {
    throw new RangeError('period 必须是正整数');
  }
  if (values.length < period) return [];
  const result: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) result.push(sum / period);
  }
  return result;
}
