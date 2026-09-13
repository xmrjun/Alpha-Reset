import type { PoolResponse, StatsResponse } from '../../src/web/contracts.js';

interface LiveSnapshot {
  type: 'snapshot';
  revision: string;
  stats: StatsResponse;
  pool: PoolResponse;
}

type Listener = (snapshot: LiveSnapshot) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let latest: LiveSnapshot | null = null;
let receivedOnConnection = false;
let reconnectTimer: number | null = null;
let releaseTimer: number | null = null;
let reconnectAttempt = 0;

function readSnapshot(data: unknown): LiveSnapshot | null {
  if (typeof data !== 'string') return null;
  try {
    const value = JSON.parse(data) as Partial<LiveSnapshot> | null;
    return value?.type === 'snapshot' && typeof value.revision === 'string'
      && value.stats !== null && typeof value.stats === 'object' && value.stats.dataQuality
      && value.pool !== null && typeof value.pool === 'object' && Array.isArray(value.pool.items)
      ? value as LiveSnapshot : null;
  } catch { return null; }
}

function scheduleReconnect(): void {
  if (!listeners.size || reconnectTimer !== null) return;
  const delay = Math.min(1_000 * 2 ** Math.min(reconnectAttempt++, 5), 30_000);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect(): void {
  if (!listeners.size || socket !== null || reconnectTimer !== null) return;
  const url = new URL('/api/live', window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let current: WebSocket;
  try { current = new WebSocket(url.href); }
  catch { scheduleReconnect(); return; }
  socket = current;
  receivedOnConnection = false;
  current.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (socket !== current) return;
    const snapshot = readSnapshot(event.data);
    if (!snapshot) return;
    // 重连后的首个完整快照总是接受，即便服务端 revision 未变化。
    const changed = !receivedOnConnection || latest?.revision !== snapshot.revision;
    receivedOnConnection = true;
    reconnectAttempt = 0;
    if (!changed) return;
    latest = snapshot;
    for (const listener of listeners) listener(snapshot);
  });
  current.addEventListener('close', () => {
    if (socket !== current) return;
    socket = null;
    receivedOnConnection = false;
    scheduleReconnect();
  });
  current.addEventListener('error', () => {
    // 浏览器随后会发 close；由同一个 close 分支安排一次重连。
    if (socket === current && current.readyState < WebSocket.CLOSING) current.close();
  });
}

/** stats 与完整观察池共用一条连接；StrictMode 的同步卸载/重订阅不重建连接。 */
export function subscribeLive(listener: Listener, replayLatest = true): () => void {
  if (releaseTimer !== null) { window.clearTimeout(releaseTimer); releaseTimer = null; }
  listeners.add(listener);
  if (latest && replayLatest) listener(latest);
  connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size || releaseTimer !== null) return;
    releaseTimer = window.setTimeout(() => {
      releaseTimer = null;
      if (listeners.size) return;
      if (reconnectTimer !== null) { window.clearTimeout(reconnectTimer); reconnectTimer = null; }
      const previous = socket;
      socket = null;
      receivedOnConnection = false;
      reconnectAttempt = 0;
      previous?.close();
    }, 0);
  };
}

/** 只在连接已送达完整快照后暂停 HTTP 兜底；断线时保留旧数据。 */
export function hasLiveSnapshot(): boolean {
  return socket?.readyState === WebSocket.OPEN && receivedOnConnection;
}
