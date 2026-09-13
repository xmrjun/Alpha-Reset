import { useState } from 'react';
import { RPS_KEYS, TAG_DETAILS, type RpsScores } from '../../src/market.js';
import type { AlertTag } from '../../src/types.js';
import type { RpsBounds } from '../../src/indicators/observation-rps.js';
import type { AlertGroup, DisplayRps, PoolViewRow } from '../../src/web/contracts.js';
import { dateTime, money } from './api.js';
import { dexScreenerUrl, gmgnUrl } from './links.js';

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

export function RpsBars({ scores, bounds, state }: {
  scores: RpsScores; bounds?: RpsBounds | undefined; state?: DisplayRps['state'] | undefined;
}) {
  const historical = state === 'previous' || state === 'stale';
  const context = state === 'previous' ? '，上一轮数据，仅供参考' : state === 'stale' ? '，已过期数据，仅供参考' : '';
  return <div className="rps-bars">{RPS_KEYS.map((key, i) => {
    const score = scores[key];
    const bound = bounds?.[key];
    const lower = bound ? (Math.floor(bound.lower * 10) / 10).toFixed(1) : '';
    const upper = bound ? (Math.ceil(bound.upper * 10) / 10).toFixed(1) : '';
    const description = (score !== null ? score.toFixed(1) + '（完整排名）'
      : bound ? lower + '–' + upper + (bound.status === 'pass' ? historical ? '，该轮下界达标' : '，下界确定达标'
        : bound.status === 'fail' ? '，确定未达标' : '，待补数据')
      : '历史不足、端点缺失或排名暂停') + context;
    const label = score !== null ? score.toFixed(1)
      : bound ? bound.status === 'pass' ? '≥' + lower : lower + '–' + upper : '—';
    return <div className="rps-column" key={key} title={key.toUpperCase() + '：' + description}>
      <div className="rps-track" role="img" aria-label={key.toUpperCase() + ' ' + description}>
        <span className={'period-' + (i < 2 ? '30m' : i < 3 ? '60m' : '4h')}
          style={{ height: (score ?? bound?.lower ?? 0) + '%' }} />
      </div><b className={'rps-value' + (score === null && bound ? ' rps-bound-label' : '')}>{label}</b>
      <small>{key.slice(1)}</small>
    </div>;
  })}</div>;
}

export function RpsCell({ row }: { row: PoolViewRow }) {
  const display = row.displayRps;
  const source = display?.source ?? row.scoreSource;
  const label = display?.state === 'previous' ? '上一轮' : display?.state === 'stale' ? '已过期' : '本轮';
  const time = display ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(display.asOf) : '';
  const hasCurrent = Object.values(row.rpsScores).some((score) => score !== null)
    || Object.values(row.rpsBounds ?? {}).some((bound) => bound !== null);
  return <div className="rps-cell" data-rps-state={display?.state ?? 'waiting'}>
    {source && <small className="rps-source">{source === 'gmgn' ? 'GMGN · 代币' : 'GeckoTerminal · 固定池'}</small>}
    <RpsBars scores={display ? display.scores : row.rpsScores}
      bounds={display ? display.bounds : row.rpsBounds} state={display?.state} />
    {display ? <small className={'rps-stamp rps-stamp-' + display.state}
      title={label + '评分；收盘基准：' + dateTime(display.asOf) + '；计算完成：' + dateTime(display.computedAt)
        + '；原观察池 ' + display.poolSize + ' 个 CA' + (display.state === 'current' ? '' : '；仅供参考，不参与本轮判定')}>
      {label} · {time}
    </small> : (display === null || !hasCurrent) && <small className="rps-stamp" title={row.calculationPending ? '新发现或身份变化的成员，等待纳入后续固定时点计算' : undefined}>等待本轮计算</small>}
  </div>;
}

export function ErrorBox({ message, retry }: { message: string | null; retry: () => void }) {
  return message ? <div className="notice" role="alert"><span>{message}</span><button onClick={retry}>重试</button></div> : null;
}

export function Empty({ title, description }: { title: string; description: string }) {
  return <div className="empty"><span className="empty-mark" aria-hidden="true">⌁</span><h3>{title}</h3><p>{description}</p></div>;
}

export function AlertCard({ item }: { item: AlertGroup }) {
  const payload = item.payload !== null && typeof item.payload === 'object'
    ? item.payload as Record<string, unknown> : {};
  const dryRun = payload.dryRun === true;
  // 触发时的 dex 快照里已含 pairAddress，用它让 DexScreener 直达交易对而非搜索页
  const dex = payload.dex !== null && typeof payload.dex === 'object'
    ? payload.dex as { pairAddress?: string | null; chainId?: string | null } : {};
  const series = payload.marketSeries !== null && typeof payload.marketSeries === 'object'
    ? payload.marketSeries as { source?: string; network?: string; poolAddress?: string } : {};
  // 触发时冻结的市值；本次改动之前的告警没有该字段，只能留空而不是拿当前值顶替。
  const marketCap = typeof payload.marketCap === 'number' && Number.isFinite(payload.marketCap)
    ? payload.marketCap : null;
  const sourceUrl = series.source === 'geckoterminal' && typeof series.network === 'string' && typeof series.poolAddress === 'string'
    ? 'https://www.geckoterminal.com/' + encodeURIComponent(series.network) + '/pools/' + encodeURIComponent(series.poolAddress) : null;
  const chain = dex.chainId ?? item.chain;
  const gmgn = gmgnUrl(item.ca, chain);
  return <article className="alert-card"><div className="alert-heading">
    <div><time dateTime={new Date(item.firedAt).toISOString()}>{dateTime(item.firedAt)}</time>
      <a className="mono" href={`/ca/${encodeURIComponent(item.ca)}`}>
        {item.symbol ? `${item.symbol} · ` : ''}{item.ca.slice(0, 8)}…{item.ca.slice(-6)} ↗</a></div>
    <div className="alert-meta">
      {marketCap !== null && <span className="alert-marketcap" title="触发时市值（A2 判定用值）">{money(marketCap)}</span>}
      <span className="status-label">{item.pushed ? '已推送' : dryRun ? '干跑记录' : '待推送 / 发送失败'}</span>
    </div>
  </div><Tags tags={item.tags} />
    <div className="alert-links">
      {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer">采集交易对 ↗</a>}
      <a href={dexScreenerUrl(item.ca, chain, dex.pairAddress)} target="_blank" rel="noreferrer">DexScreener ↗</a>
      {gmgn && <a href={gmgn} target="_blank" rel="noreferrer">GMGN ↗</a>}
    </div>
    <details><summary>触发时指标快照</summary><pre>{JSON.stringify(item.payload, null, 2)}</pre></details>
  </article>;
}
