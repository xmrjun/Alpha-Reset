import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCalculationCoordinator } from '../../src/scheduler/calculation-coordinator.js';
import { runGmgnCollectionLoop } from '../../src/scheduler/main.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = 100 * HOUR;
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function deferred<V>() {
  let resolve!: (value: V) => void;
  const promise = new Promise<V>((done) => { resolve = done; });
  return { promise, resolve };
}
class VirtualClock {
  now = T;
  sequence = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  schedule = (callback: () => void, delay: number) => {
    assert.ok(delay > 0 && delay <= MINUTE, '长等待按最多一分钟切片');
    const id = ++this.sequence;
    this.timers.set(id, { at: this.now + delay, callback });
    return () => { this.timers.delete(id); };
  };
  async advanceTo(time: number) {
    assert.ok(time >= this.now);
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > time) break;
      this.now = next[1].at; this.timers.delete(next[0]); next[1].callback();
      await flush();
    }
    this.now = time;
    await flush();
  }
}
function fixture(calculate?: (time: number) => Promise<boolean>) {
  const clock = new VirtualClock();
  const calls: { time: number; at: number }[] = [];
  const coordinator = createCalculationCoordinator({ intervalMs: HOUR, revisionMs: 3 * MINUTE,
    clock: () => clock.now, schedule: clock.schedule,
    calculate: async (time) => { calls.push({ time, at: clock.now }); return calculate ? calculate(time) : true; } });
  return { clock, coordinator, calls };
}

test('Gecko、GMGN与后续discovery共享3分钟门，连续请求不延后截止也不能提前重算', async () => {
  const f = fixture();
  f.coordinator.request('boundary'); await flush();
  await f.clock.advanceTo(T + 1_000); f.coordinator.request('data'); // Gecko
  await f.clock.advanceTo(T + 2_000); f.coordinator.request('data'); // GMGN
  await f.clock.advanceTo(T + 5_000); f.coordinator.request('observation');
  for (let minute = 1; minute < 3; minute++) {
    await f.clock.advanceTo(T + minute * MINUTE); f.coordinator.request('data');
    f.coordinator.request('observation');
  }
  await f.clock.advanceTo(T + 3 * MINUTE - 1);
  assert.deepEqual(f.calls, [{ time: T, at: T }]);
  await f.clock.advanceTo(T + 3 * MINUTE);
  assert.deepEqual(f.calls, [{ time: T, at: T }, { time: T, at: T + 3 * MINUTE }]);
  f.coordinator.request('data'); f.coordinator.request('observation');
  await f.clock.advanceTo(T + 6 * MINUTE - 1); assert.equal(f.calls.length, 2);
  await f.clock.advanceTo(T + 6 * MINUTE); assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2]!.at - f.calls[1]!.at, 3 * MINUTE);
  await f.coordinator.stop();
});

test('首次有效观察池可立即建立T，建立后同T任何群刷新都必须节流', async () => {
  let validPool = false;
  const f = fixture(async () => validPool);
  f.coordinator.request('boundary'); await flush();
  await f.clock.advanceTo(T + MINUTE); f.coordinator.request('data');
  validPool = true;
  await f.clock.advanceTo(T + MINUTE + 1_000); f.coordinator.request('observation'); await flush();
  assert.deepEqual(f.calls.map((call) => call.at), [T, T + MINUTE + 1_000]);
  await f.clock.advanceTo(T + MINUTE + 2_000); f.coordinator.request('observation');
  await f.clock.advanceTo(T + 4 * MINUTE + 999); assert.equal(f.calls.length, 2);
  await f.clock.advanceTo(T + 4 * MINUTE + 1_000); assert.equal(f.calls.length, 3);
  await f.coordinator.stop();
});

test('新小时立即计算并替换待修订的旧T，不会被上一小时3分钟门阻塞', async () => {
  const f = fixture();
  f.clock.now = T + 58 * MINUTE + 30_000;
  f.coordinator.request('boundary'); await flush();
  await f.clock.advanceTo(T + 59 * MINUTE); f.coordinator.request('data');
  await f.clock.advanceTo(T + HOUR); f.coordinator.request('boundary'); await flush();
  assert.deepEqual(f.calls, [{ time: T, at: T + 58 * MINUTE + 30_000 }, { time: T + HOUR, at: T + HOUR }]);
  await f.clock.advanceTo(T + HOUR + 5 * MINUTE);
  assert.equal(f.calls.length, 2, '旧T待处理timer已取消');
  await f.coordinator.stop();
});

test('异步通知期间合并触发且不重入，新小时优先于积压的旧T', async () => {
  const release = deferred<boolean>(); let invocation = 0;
  const f = fixture(async () => ++invocation === 1 ? release.promise : true);
  f.coordinator.request('boundary'); await flush();
  await f.clock.advanceTo(T + MINUTE); f.coordinator.request('data');
  f.coordinator.request('observation');
  await f.clock.advanceTo(T + 4 * MINUTE); f.coordinator.request('data');
  assert.equal(f.calls.length, 1);
  await f.clock.advanceTo(T + HOUR); f.coordinator.request('boundary');
  f.coordinator.request('data');
  assert.equal(f.calls.length, 1);
  release.resolve(true); await flush();
  assert.deepEqual(f.calls, [{ time: T, at: T }, { time: T + HOUR, at: T + HOUR }]);
  await f.coordinator.stop();
});

test('关机取消待运行修订并等待已开始的计算，后续请求无效', async () => {
  const release = deferred<boolean>();
  const f = fixture(async () => release.promise);
  f.coordinator.request('boundary'); await flush();
  f.coordinator.request('data');
  let stopped = false;
  const stopping = f.coordinator.stop().then(() => { stopped = true; });
  await flush(); assert.equal(stopped, false);
  release.resolve(true); await stopping;
  f.coordinator.request('observation'); f.coordinator.request('boundary');
  await f.clock.advanceTo(T + HOUR);
  assert.equal(f.calls.length, 1); assert.equal(f.clock.timers.size, 0);
  const g = fixture(); g.coordinator.request('boundary'); await flush(); g.coordinator.request('data');
  assert.ok(g.clock.timers.size > 0); await g.coordinator.stop(); assert.equal(g.clock.timers.size, 0);
});

test('同T计算失败不形成重试忙循环，后续数据仍在同一个修订间隔重试', async () => {
  const f = fixture(async () => { throw new Error('test failure'); });
  f.coordinator.request('boundary'); await flush();
  await f.clock.advanceTo(T + 2_000); f.coordinator.request('data');
  await f.clock.advanceTo(T + 3 * MINUTE - 1); assert.equal(f.calls.length, 1);
  await f.clock.advanceTo(T + 3 * MINUTE); assert.equal(f.calls.length, 2);
  await f.coordinator.stop();
});

test('实际GMGN持续循环与Gecko/discovery触发汇入协调器，采集200次也只按3分钟计算', async () => {
  const f = fixture(); let stopped = false; let attempts = 0;
  f.coordinator.request('boundary'); await flush();
  await runGmgnCollectionLoop({ intervalMs: HOUR, clock: () => f.clock.now, stopped: () => stopped,
    collector: { async collectOnce() {
      attempts++;
      if (attempts % 7 === 0) f.coordinator.request('data'); // 同时到达的 Gecko 更新
      if (attempts % 11 === 0) f.coordinator.request('observation');
      return { attempted: true, nextAt: f.clock.now + 2_000, changed: true };
    } },
    requestCalculation: async (time) => { assert.equal(time, T); f.coordinator.request('data'); },
    sleep: async (ms) => { await f.clock.advanceTo(f.clock.now + ms); if (f.clock.now >= T + 400_000) stopped = true; },
  });
  assert.equal(attempts, 200);
  assert.deepEqual(f.calls.map((call) => call.at), [T, T + 3 * MINUTE, T + 6 * MINUTE]);
  assert.ok(f.calls.every((call) => call.time === T));
  await f.coordinator.stop();
});
