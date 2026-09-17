import { useState } from 'react';
import { RPS_KEYS, TAG_DETAILS, type RpsScores } from '../../src/market.js';
import type { AlertTag } from '../../src/types.js';
import type { RpsBounds } from '../../src/indicators/observation-rps.js';
import type { AlertGroup, DisplayRps, OutcomesResponse, PoolViewRow } from '../../src/web/contracts.js';
import { dateTime, money } from './api.js';
import { useCopy } from './i18n.js';
import { dexScreenerUrl, gmgnUrl } from './links.js';

export function Tags({ tags }: { tags: AlertTag[] }) {
  const { lang } = useCopy();
  const label = (tag: AlertTag) => lang === 'en' ? TAG_DETAILS[tag].labelEn : TAG_DETAILS[tag].label;
  return <div className="tags">{tags.map((tag) => <span key={tag} className="chip" title={label(tag)}>
    <i className={`dot period-${TAG_DETAILS[tag].period}`} aria-hidden="true" />
    <span aria-hidden="true">{TAG_DETAILS[tag].icon}</span> {label(tag)}
  </span>)}</div>;
}

export function CopyCa({ ca, full = false }: { ca: string; full?: boolean }) {
  const { t } = useCopy();
  const [message, setMessage] = useState<'copy' | 'copied' | 'failed'>('copy');
  const text = message === 'copy' ? t.copy : message === 'copied' ? t.copied : t.copyFailed;
  return <span className={`copy-ca ${full ? 'full' : ''}`}><code title={ca}>{full ? ca : `${ca.slice(0, 6)}…${ca.slice(-4)}`}</code>
    <button className="text-button" aria-label={t.copyAria(ca)} onClick={() => {
      navigator.clipboard.writeText(ca).then(() => setMessage('copied')).catch(() => setMessage('failed'));
    }}>{text}</button><span className="sr-only" aria-live="polite">{message === 'copy' ? '' : text}</span></span>;
}

export function RpsBars({ scores, bounds, state }: {
  scores: RpsScores; bounds?: RpsBounds | undefined; state?: DisplayRps['state'] | undefined;
}) {
  const { t } = useCopy();
  const historical = state === 'previous' || state === 'stale';
  const context = state === 'previous' ? t.rpsCtxPrevious : state === 'stale' ? t.rpsCtxStale : '';
  return <div className="rps-bars">{RPS_KEYS.map((key, i) => {
    const score = scores[key];
    const bound = bounds?.[key];
    const lower = bound ? (Math.floor(bound.lower * 10) / 10).toFixed(1) : '';
    const upper = bound ? (Math.ceil(bound.upper * 10) / 10).toFixed(1) : '';
    const description = (score !== null ? t.rpsComplete(score.toFixed(1))
      : bound ? lower + '–' + upper + (bound.status === 'pass' ? historical ? t.rpsBoundPassHistoric : t.rpsBoundPass
        : bound.status === 'fail' ? t.rpsBoundFail : t.rpsBoundUnknown)
      : t.rpsNoData) + context;
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
  const { t } = useCopy();
  const display = row.displayRps;
  const source = display?.source ?? row.scoreSource;
  const label = display?.state === 'previous' ? t.rpsCellPrevious : display?.state === 'stale' ? t.rpsCellStale : t.rpsCellCurrent;
  const time = display ? new Intl.DateTimeFormat(t.dateLocale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(display.asOf) : '';
  const hasCurrent = Object.values(row.rpsScores).some((score) => score !== null)
    || Object.values(row.rpsBounds ?? {}).some((bound) => bound !== null);
  return <div className="rps-cell" data-rps-state={display?.state ?? 'waiting'}>
    {source && <small className="rps-source">{source === 'gmgn' ? t.rpsSourceGmgn
      : source === 'binance' ? t.rpsSourceBinance : t.rpsSourceGecko}</small>}
    <RpsBars scores={display ? display.scores : row.rpsScores}
      bounds={display ? display.bounds : row.rpsBounds} state={display?.state} />
    {display ? <small className={'rps-stamp rps-stamp-' + display.state}
      title={t.rpsStampTitle(label, dateTime(display.asOf, t), dateTime(display.computedAt, t), display.poolSize,
        display.state === 'current' ? '' : t.rpsStampNotCurrent)}>
      {label} · {time}
    </small> : (display === null || !hasCurrent) && <small className="rps-stamp" title={row.calculationPending ? t.rpsPendingTitle : undefined}>{t.rpsWaitingRound}</small>}
  </div>;
}

export function ErrorBox({ message, retry }: { message: string | null; retry: () => void }) {
  const { t } = useCopy();
  return message ? <div className="notice" role="alert"><span>{message}</span><button onClick={retry}>{t.retry}</button></div> : null;
}

export function Empty({ title, description }: { title: string; description: string }) {
  return <div className="empty"><span className="empty-mark" aria-hidden="true">⌁</span><h3>{title}</h3><p>{description}</p></div>;
}

export function AlertCard({ item }: { item: AlertGroup }) {
  const { t } = useCopy();
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
    <div><time dateTime={new Date(item.firedAt).toISOString()}>{dateTime(item.firedAt, t)}</time>
      <a className="mono" href={`/ca/${encodeURIComponent(item.ca)}`}>
        {item.symbol ? `${item.symbol} · ` : ''}{item.ca.slice(0, 8)}…{item.ca.slice(-6)} ↗</a></div>
    <div className="alert-meta">
      {marketCap !== null && <span className="alert-marketcap" title={t.alertMarketCapTitle}>{money(marketCap)}</span>}
      <span className="status-label">{item.pushed ? t.alertPushed : dryRun ? t.alertDryRun : t.alertPending}</span>
    </div>
  </div><Tags tags={item.tags} />
    <div className="alert-links">
      {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer">{t.linkPair}</a>}
      <a href={dexScreenerUrl(item.ca, chain, dex.pairAddress)} target="_blank" rel="noreferrer">DexScreener ↗</a>
      {gmgn && <a href={gmgn} target="_blank" rel="noreferrer">GMGN ↗</a>}
    </div>
    <details><summary>{t.alertSnapshot}</summary><pre>{JSON.stringify(item.payload, null, 2)}</pre></details>
  </article>;
}

const pct = (value: number | null) => value === null ? '—' : (value >= 0 ? '+' : '') + value.toFixed(1) + '%';

/** 展开状态按浏览器记住；存储不可用时退回默认收起，不影响渲染。 */
function initialOutcomesOpen(): boolean {
  try { return localStorage.getItem('alpha-outcomes-open') === '1'; } catch { return false; }
}

export function Outcomes({ data }: { data: OutcomesResponse | null }) {
  const { t, lang } = useCopy();
  const [open, setOpen] = useState(initialOutcomesOpen);
  if (!data || !data.horizons.length) return <p className="rps-waiting">{t.outcomesNoData}</p>;
  const hasControl = data.horizons.some((row) => row.control.n > 0);
  // 收起时标题栏仍给出最短窗口的触发组结果，否则折叠等于看不见。
  const glance = data.horizons[0];
  return <section className="panel outcomes" aria-label={t.outcomesTitle}>
    <details open={open} onToggle={(event) => {
      const next = event.currentTarget.open;
      setOpen(next);
      try { localStorage.setItem('alpha-outcomes-open', next ? '1' : '0'); } catch { /* 不依赖持久化 */ }
    }}>
    <summary className="outcomes-summary" aria-label={t.outcomesToggle}>
      {/* 折叠标记用真实元素，不用 CSS content：content 的值必须带引号，
          而引号穿过多层脚本写入样式文件时容易被吃掉，生成 content:▸ 这种
          非法声明后整条被静默丢弃。放进 JSX 就没有这一层风险。 */}
      <span className="outcomes-caret" aria-hidden="true">▸</span>
      <span className="outcomes-summary-title">{t.outcomesTitle}</span>
      <span className="outcomes-glance">{glance && glance.alerted.n > 0
        ? t.outcomesGlance(glance.horizonHours, pct(glance.alerted.median), glance.alerted.n)
        : t.outcomesGlanceEmpty}</span>
      <span className="outcomes-summary-hint">{t.outcomesHint}</span>
    </summary>
    {!hasControl && <div className="notice" role="status"><span className="notice-symbol">!</span>
      <div><p>{t.outcomesControlWarn}</p></div></div>}
    {hasControl && data.controlSince !== null && <p className="outcomes-note">{t.outcomesControlSince(dateTime(data.controlSince, t))}</p>}
    <div className="table-scroll"><table className="outcomes-table"><thead><tr>
      <th>{t.outcomesHorizon}</th>
      <th className="numeric group" colSpan={3}>{t.outcomesAlerted}</th>
      <th className="numeric group" colSpan={3}>{t.outcomesControl}</th>
      <th className="numeric">{t.outcomesDiff}</th>
    </tr><tr className="outcomes-subhead">
      <th />
      <th className="numeric">{t.outcomesN}</th><th className="numeric">{t.outcomesMedian}</th><th className="numeric">{t.outcomesWin}</th>
      <th className="numeric">{t.outcomesN}</th><th className="numeric">{t.outcomesMedian}</th><th className="numeric">{t.outcomesWin}</th>
      <th />
    </tr></thead><tbody>{data.horizons.map((row) => {
      const gap = row.alerted.median !== null && row.control.median !== null ? row.alerted.median - row.control.median : null;
      return <tr key={row.horizonHours}>
        <td>{row.horizonHours}h</td>
        <td className="numeric">{row.alerted.n}</td>
        <td className="numeric">{pct(row.alerted.median)}</td>
        <td className="numeric">{row.alerted.winRate === null ? '—' : row.alerted.winRate.toFixed(0) + '%'}</td>
        <td className="numeric">{row.control.n}</td>
        <td className="numeric">{pct(row.control.median)}</td>
        <td className="numeric">{row.control.winRate === null ? '—' : row.control.winRate.toFixed(0) + '%'}</td>
        <td className="numeric">{pct(gap)}</td>
      </tr>;
    })}</tbody></table></div>
    {data.tags.length > 0 && <><h3 className="outcomes-subtitle">{t.outcomesTagTitle}</h3>
      <div className="table-scroll"><table className="outcomes-table"><thead><tr>
        <th>{t.outcomesTag}</th><th className="numeric">{t.outcomesHorizon}</th><th className="numeric">{t.outcomesN}</th><th className="numeric">{t.outcomesMedian}</th><th className="numeric">{t.outcomesWin}</th>
      </tr></thead><tbody>{data.tags.map((row) => <tr key={row.tag + row.horizonHours}>
        <td>{lang === 'en' ? TAG_DETAILS[row.tag as AlertTag]?.labelEn ?? row.tag : TAG_DETAILS[row.tag as AlertTag]?.label ?? row.tag}</td>
        <td className="numeric">{row.horizonHours}h</td>
        <td className="numeric">{row.n}</td>
        <td className="numeric">{pct(row.median)}</td>
        <td className="numeric">{row.winRate === null ? '—' : row.winRate.toFixed(0) + '%'}</td>
      </tr>)}</tbody></table></div></>}
    <p className="outcomes-note">{t.outcomesCaveat}
      {data.pending > 0 && ' · ' + t.outcomesPending(data.pending)}
      {data.settledAt !== null && ' · ' + t.outcomesSettledAt(dateTime(data.settledAt, t))}</p>
    </details>
  </section>;
}
