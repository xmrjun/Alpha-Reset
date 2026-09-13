export type CalculationRequest = 'boundary' | 'data' | 'observation';

/** 单个生产 owner 共享此协调器；各数据源只能标记更新，不能单独绕过修订间隔。 */
export function createCalculationCoordinator(opts: {
  intervalMs: number;
  revisionMs: number;
  clock: () => number;
  /** true 表示该 T 已有完整观察池；null/无输入变化由调用方结合已存快照判断。 */
  calculate: (time: number) => Promise<boolean>;
  log?: (event: Record<string, unknown>) => void;
  /** 返回取消函数，便于虚拟时钟测试；生产默认使用 setTimeout。 */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}) {
  if (!Number.isSafeInteger(opts.intervalMs) || opts.intervalMs <= 0
    || !Number.isSafeInteger(opts.revisionMs) || opts.revisionMs <= 0) throw new RangeError('计算时间间隔无效');
  const schedule = opts.schedule ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  });
  let stopped = false;
  let cancelTimer: (() => void) | null = null;
  let running: Promise<void> | null = null;
  let pending: { time: number; observation: boolean } | null = null;
  let lastStartedAt = -Infinity;
  let lastSlot: number | null = null;
  let readySlot: number | null = null;
  const baseline = () => Math.floor(opts.clock() / opts.intervalMs) * opts.intervalMs;

  function plan(): void {
    cancelTimer?.(); cancelTimer = null;
    if (stopped || running || !pending) return;
    // 时钟越过整点而 cron 尚未运行时，也不能补算过期的 T。
    pending.time = Math.max(pending.time, baseline());
    const now = opts.clock();
    const immediate = pending.time !== lastSlot || (pending.observation && readySlot !== pending.time);
    const due = immediate ? now : lastStartedAt + opts.revisionMs;
    if (due > now) {
      cancelTimer = schedule(() => { cancelTimer = null; plan(); }, Math.min(due - now, 60_000));
      return;
    }
    const time = pending.time;
    pending = null;
    lastStartedAt = now; lastSlot = time;
    // 先登记 in-flight，再执行可能同步发布 SQLite 快照的 calculate，保证重入仍只能排队。
    running = Promise.resolve().then(() => opts.calculate(time)).then((completePool) => {
      if (completePool) readySlot = time;
    }, () => { opts.log?.({ event: 'calculation_failed', time }); }).finally(() => {
      running = null;
      plan();
    });
  }

  return {
    request(reason: CalculationRequest = 'data'): void {
      if (stopped) return;
      const time = baseline();
      if (reason === 'boundary' && time === lastSlot) return;
      if (!pending || time > pending.time) pending = { time, observation: reason === 'observation' };
      else pending.observation ||= reason === 'observation';
      plan();
    },
    /** 关机丢弃尚未开始的修订，只等待已开始的计算与通知。 */
    stop(): Promise<void> {
      stopped = true; pending = null;
      cancelTimer?.(); cancelTimer = null;
      return running ?? Promise.resolve();
    },
  };
}
