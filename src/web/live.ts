import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { StoreDatabase } from '../store/db.js';
import type { PoolResponse, StatsResponse } from './contracts.js';

export interface LiveSnapshot { stats: StatsResponse; pool: PoolResponse }

/** 只读取本地数据库，向浏览器推送完整快照；不访问任何行情上游。 */
export function attachLiveFeed(opts: {
  server: Server; db: StoreDatabase; readSnapshot: () => LiveSnapshot; readVersion: () => string; intervalMs?: number;
}) {
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 });
  const alive = new WeakSet<WebSocket>();
  let interval: ReturnType<typeof setInterval> | undefined;
  let lastChange = '';
  let lastMessage = '';
  let lastRevision = '';
  let closed = false;
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');

  function refresh() {
    // 版本比较与快照使用同一读事务；仅相关状态改变才重建，任意历史写入不再触发全池计算。
    const next = opts.db.transaction(() => {
      const change = opts.readVersion();
      if (change === lastChange && lastMessage) return null;
      return { change, data: opts.readSnapshot() };
    })();
    if (!next) return false;
    const serialized = JSON.stringify(next.data);
    const revision = hash(serialized);
    lastChange = next.change;
    if (revision === lastRevision) return false;
    lastRevision = revision;
    // stats/pool 已序列化一次，避免再次遍历整份快照。
    lastMessage = '{"type":"snapshot","revision":' + JSON.stringify(revision) + ',' + serialized.slice(1);
    return true;
  }
  function send(socket: WebSocket) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.terminate(); return; }
    socket.send(lastMessage, (error) => { if (error) socket.terminate(); });
  }
  function broadcast() {
    if (closed || sockets.clients.size === 0) return;
    try { if (refresh()) for (const socket of sockets.clients) send(socket); }
    catch { for (const socket of sockets.clients) socket.close(1011, 'Snapshot unavailable'); }
  }
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!alive.has(socket)) { socket.terminate(); continue; }
      alive.delete(socket); socket.ping();
    }
  }, 30_000);
  heartbeat.unref();

  sockets.on('connection', (socket) => {
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
    socket.on('error', () => { /* 连接错误仅影响该客户端。 */ });
    socket.on('message', () => socket.close(1008, 'Server push only'));
    try {
      if (refresh()) for (const client of sockets.clients) send(client);
      else send(socket);
    }
    catch { socket.close(1011, 'Snapshot unavailable'); }
    if (!interval) {
      interval = setInterval(broadcast, opts.intervalMs ?? 1000);
      interval.unref();
    }
    socket.on('close', () => {
      if (sockets.clients.size === 0 && interval) { clearInterval(interval); interval = undefined; }
    });
  });
  opts.server.on('upgrade', (request, socket, head) => {
    if (closed) { socket.destroy(); return; }
    let accepted = false;
    try {
      accepted = new URL(request.url ?? '/', 'http://localhost').pathname === '/api/live'
        && (!request.headers.origin || new URL(request.headers.origin).host === request.headers.host);
    } catch { /* 无效Origin/路径拒绝升级。 */ }
    if (!accepted) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit('connection', websocket, request));
  });
  function close() {
    if (closed) return;
    closed = true;
    if (interval) clearInterval(interval);
    clearInterval(heartbeat);
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  }
  opts.server.once('close', close);
  opts.server.once('shutdown', close);
  return { close, broadcast };
}
