import { useState } from 'react';
import { RPS_KEYS, TAG_DETAILS, type RpsScores } from '../../src/market.js';
import type { AlertTag } from '../../src/types.js';
import type { AlertGroup } from '../../src/web/contracts.js';
import { dateTime } from './api.js';

export function Tags({ tags }: { tags: AlertTag[] }) {
  return <div className="tags">{tags.map((tag) => <span key={tag} className="chip" title={TAG_DETAILS[tag].label}>
    <i className={`dot period-${TAG_DETAILS[tag].period}`} aria-hidden="true" />
    <span aria-hidden="true">{TAG_DETAILS[tag].icon}</span> {TAG_DETAILS[tag].label}
  </span>)}</div>;
}

export function CopyCa({ ca, full = false }: { ca: string; full?: boolean }) {
  const [message, setMessage] = useState('复制');
  return <span className={`copy-ca ${full ? 'full' : ''}`}><code title={ca}>{full ? ca : `${ca.slice(0, 6)}…${ca.slice(-4)}`}</code>
    <button className="text-button" aria-label={`复制 ${ca}`} onClick={() => {
      navigator.clipboard.writeText(ca).then(() => setMessage('已复制')).catch(() => setMessage('复制失败'));
    }}>{message}</button><span className="sr-only" aria-live="polite">{message === '复制' ? '' : message}</span></span>;
}

export function RpsBars({ scores }: { scores: RpsScores }) {
  return <div className="rps-bars">{RPS_KEYS.map((key, i) => <div className="rps-column" key={key}
    title={`${key.toUpperCase()}：${scores[key] === null ? '数据不足或排名暂停' : scores[key]!.toFixed(1)}`}>
    <div className="rps-track" role="img" aria-label={`${key.toUpperCase()} ${scores[key] ?? '未知'}`}>
      <span className={`period-${i < 2 ? '30m' : i < 3 ? '60m' : '4h'}`} style={{ height: `${scores[key] ?? 0}%` }} />
      {scores[key] === null && <b>—</b>}</div><small>{key.slice(1)}</small></div>)}</div>;
}

export function ErrorBox({ message, retry }: { message: string | null; retry: () => void }) {
  return message ? <div className="notice" role="alert"><span>{message}</span><button onClick={retry}>重试</button></div> : null;
}

export function Empty({ title, description }: { title: string; description: string }) {
  return <div className="empty"><span className="empty-mark" aria-hidden="true">⌁</span><h3>{title}</h3><p>{description}</p></div>;
}

export function AlertCard({ item }: { item: AlertGroup }) {
  const dryRun = item.payload !== null && typeof item.payload === 'object' && 'dryRun' in item.payload && item.payload.dryRun === true;
  return <article className="alert-card"><div className="alert-heading">
    <div><time dateTime={new Date(item.firedAt).toISOString()}>{dateTime(item.firedAt)}</time>
      <a className="mono" href={`/ca/${encodeURIComponent(item.ca)}`}>{item.ca.slice(0, 8)}…{item.ca.slice(-6)} ↗</a></div>
    <span className="status-label">{item.pushed ? '已推送' : dryRun ? '干跑记录' : '待推送 / 发送失败'}</span>
  </div><Tags tags={item.tags} />
    <details><summary>触发时指标快照</summary><pre>{JSON.stringify(item.payload, null, 2)}</pre></details>
  </article>;
}
