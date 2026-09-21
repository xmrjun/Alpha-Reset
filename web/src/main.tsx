import { StrictMode, useLayoutEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AlertsResponse, DetailResponse, OutcomesResponse, PoolResponse, PoolViewRow, StatsResponse } from '../../src/web/contracts.js';
import { PERIODS, RPS_KEYS, TAG_DETAILS, type Period } from '../../src/market.js';
import { dateTime, money, number, relativeTime, useApi } from './api.js';
import { AlertCard, CopyCa, Empty, ErrorBox, Outcomes, RpsCell, Tags } from './components.js';
import { AgentPanel } from './AgentPanel.js';
import { COPY, detectLang, LangContext, persistLang, useCopy, type Lang } from './i18n.js';
import { PriceChart } from './Chart.js';
import './style.css';
import { dexScreenerUrl, gmgnUrl } from './links.js';

function initialTheme() {
  try { const value = localStorage.getItem('alpha-theme'); if (value === 'light' || value === 'dark') return value; } catch { /* 存储不可用时仍可切换 */ }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function Overview({ stats }: { stats: StatsResponse | null }) {
  const { t, lang } = useCopy();
  const api = useApi<PoolResponse>('/api/pool?limit=1000');
  const [chain, setChain] = useState(''); const [group, setGroup] = useState('');
  const [hit, setHit] = useState(''); const [search, setSearch] = useState(''); const [sort, setSort] = useState('-lastAlertAt');
  const pools = api.data?.items ?? [];
  const chains = [...new Set(pools.map((row) => row.chain).filter((value): value is string => value !== null))].sort();
  const groups = [...new Set(pools.flatMap((row) => row.groupName?.split('、') ?? []))].sort();
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const selected = (api.data?.items ?? []).filter((row) => (!chain || row.chain === chain) && (!group || row.groupName?.split('、').includes(group))
      && (!hit || Boolean(row.tags.length) === (hit === '1')) && (!needle || `${row.ca} ${row.symbol ?? ''}`.toLowerCase().includes(needle)));
    const field = sort.replace(/^-/, '') as keyof PoolViewRow;
    const direction = sort.startsWith('-') ? -1 : 1;
    return selected.sort((a, b) => {
      const left = a[field]; const right = b[field];
      if (left == null) return right == null ? 0 : 1;
      if (right == null) return -1;
      return direction * (typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right)));
    });
  }, [api.data, chain, group, hit, search, sort]);
  const header = (label: string, key: string) => <th aria-sort={sort.replace(/^-/, '') === key ? sort.startsWith('-') ? 'descending' : 'ascending' : 'none'}>
    <button onClick={() => setSort(sort === key ? `-${key}` : key)}>{label} <span aria-hidden="true">{sort === key ? '↑' : sort === `-${key}` ? '↓' : '↕'}</span></button></th>;
  const used = stats?.quota.used ?? 0; const limit = stats?.quota.limit ?? 1;
  const quality = stats?.dataQuality;
  const mainMinutes = stats?.refreshMinutes ?? 60;
  const revisionMinutes = stats?.revisionMinutes ?? 3;
  const inactiveHours = ((stats?.inactiveAfterBars ?? 16) * 15) / 60;
  const observation = quality?.observation;
  const calculation = quality?.calculation;
  const collection = quality?.collection;
  const gmgn = quality?.gmgn;
  const binance = quality?.binance;
  const collectingCount = collection?.memberCount ?? quality?.monitored ?? 0;
  const latestSweepMinutes = observation && collection?.effectiveRpm
    ? observation.memberCount / collection.effectiveRpm : null;
  const display = quality?.rpsDisplay;
  // 运行中的覆盖计数尚未完成，只展示最近已完成计算对应的覆盖。
  const coverage = display?.coverage ?? (quality?.rpsDisplay === undefined && !quality?.roundRunning ? quality?.rpsCoverage : null);
  const displayLabel = display?.state === 'previous' ? t.rpsStatePrevious : display?.state === 'stale' ? t.rpsStateStale : t.rpsStateCurrent;
  return <><div className="page-heading"><div><p className="eyebrow">{t.overviewEyebrow}</p><h1>{t.overviewTitle}</h1><p>{t.overviewLead}</p></div>
    <button onClick={api.reload}>{t.reload}</button></div>
    <section className="stats-grid" aria-label={t.statsLabel}>
      <div className="stat-tile"><span>{t.statPool}</span><strong>{stats ? number(stats.poolSize) : '—'}</strong><small>{t.statPoolHint}</small></div>
      <div className="stat-tile"><span>{t.statAlerts}</span><strong>{stats ? number(stats.alertsToday) : '—'}</strong><small>{t.statAlertsHint}</small></div>
      <div className="stat-tile"><span>{t.statQuota}</span><strong>{stats ? number(used) : '—'} <em>/ {stats ? number(limit) : '—'}</em></strong>
        <progress aria-label={t.statQuotaLabel} value={used} max={limit} className={used / limit * 100 >= (stats?.quotaWarningPercent ?? 100) ? 'quota-warning' : ''} /></div>
      <div className="stat-tile"><span>{t.statRefresh}</span><strong className="time-stat" title={dateTime(stats?.lastRunAt, t)}>{relativeTime(stats?.lastRunAt ?? null, t)}</strong>
        <small>{observation ? t.refreshEveryList(observation.refreshMinutes) : stats ? t.refreshEveryStrategy(stats.refreshMinutes) : t.waitingService}</small></div>
    </section>
    {observation && <section className="panel observation-summary" aria-label={t.observationTitle}>
      <div className="panel-heading"><h2>{t.observationTitle}</h2><span>{t.observationCounts(number(observation.sourceCount), number(observation.memberCount))}</span></div>
      <div className="observation-summary-body">
        <p>{t.observationUpdated}{observation.updatedAt === null ? t.observationWaiting : <time dateTime={new Date(observation.updatedAt).toISOString()}>{dateTime(observation.updatedAt, t)}</time>}{t.observationEvery(observation.refreshMinutes)}</p>
        {observation.discoveryStatus && observation.discoveryStatus !== 'complete' && <p className={'discovery-status discovery-' + observation.discoveryStatus} role="status">
          {observation.discoveryStatus === 'running' ? t.discoveryRunning
            : observation.discoveryStatus === 'failed' ? t.discoveryFailed(observation.discoveryFailures ?? 0)
            : observation.discoveryStatus === 'halted' ? t.discoveryHalted
            : t.discoveryPartial(observation.discoveryFailures ?? 0)}
          {observation.discoveryStatus !== 'partial' && (observation.updatedAt === null ? t.discoveryNoList : t.discoveryKeepList)}
          {observation.lastAttemptAt != null && <>{t.discoveryLastTry}<time dateTime={new Date(observation.lastAttemptAt).toISOString()}>{dateTime(observation.lastAttemptAt, t)}</time></>}
        </p>}
        {observation.addedCount !== undefined && observation.removedCount !== undefined
          && <p>{t.observationDelta(observation.addedCount, observation.removedCount)}</p>}
        {calculation && <p className="calculation-summary">{t.calculationSummary(number(calculation.memberCount), dateTime(calculation.asOf, t))}</p>}
        {latestSweepMinutes !== null && <p className="sweep-estimate">{t.sweepEstimate(number(collection?.effectiveRpm), number(latestSweepMinutes))}</p>}
        {observation.upstreamLimited && <p className="observation-limited">{t.upstreamLimited}</p>}
      </div>
    </section>}
    {quality?.roundRunning && (
      <div className="notice collection-notice" role="status"><span className="notice-symbol">i</span><div>
        <strong>{t.collectingTitle}</strong>
        {collection?.boardComplete === false ? <p>{t.collectingReadingPool}</p>
          : collection ? <>
            {observation && <p>{t.collectingScope(number(collectingCount), number(observation.memberCount))}</p>}
            <p>{t.collectingProgress(collection.processed, number(collectingCount), collection.succeeded, collection.failed)}</p>
            <progress aria-label={t.collectingProgressLabel} value={collection.processed} max={Math.max(collectingCount, 1)} />
            <p>{t.collectingEndpoints(quality.freshPriceCount, number(collectingCount), collection.historyAvailable)}</p>
            {collection.minSweepMinutes !== undefined && <p>{t.collectingSweep(number(collection.minSweepMinutes))}</p>}
            <p>{t.collectingBaseline(dateTime(collection.baselineAt, t))}</p>
          </> : <p>{t.collectingFallback(quality.monitored)}</p>}
        <p>{!display && t.collectingNoScore}{t.collectingCadence(mainMinutes, revisionMinutes)}</p>
      </div></div>
    )}
    {(calculation?.sources || gmgn?.enabled || binance?.enabled) && <section className="panel market-sources" aria-label={t.sourcesTitle}>
      <div className="panel-heading"><h2>{t.sourcesTitle}</h2><span>{t.sourcesHint}</span></div>
      <div className="market-sources-body">
        {calculation?.sources && <p className="scoring-sources">{t.sourcesBreakdown(number(calculation.sources.gmgn), number(calculation.sources.geckoterminal), number(calculation.sources.binance), number(calculation.sources.unbound), dateTime(calculation.asOf, t))}</p>}
        {/* 每个 token 源一块状态面板；承担份额大的排前面，缺任何一块都会让人看不见主力源在做什么。 */}
        {([{ name: 'Binance Web3', s: binance }, { name: 'GMGN', s: gmgn }] as const)
          .map(({ name, s }) => s?.enabled ? (
          <div key={name} className="gmgn-status" role="status" data-status={s.status ?? 'waiting'}>
            <p><strong>{name} · {s.status === 'running' ? t.gmgnRunning : s.status === 'cooldown' ? t.gmgnCooldown
              : s.status === 'auth_error' ? t.gmgnAuthError : s.status === 'disabled' ? t.gmgnDisabled
              : s.status === 'idle' ? t.gmgnIdle : t.gmgnUnknown}</strong>{t.gmgnRpm(number(s.effectiveRpm))}</p>
            {s.status === 'cooldown' && s.cooldownUntil > 0 && <p>{t.gmgnCooldownUntil(dateTime(s.cooldownUntil, t))}</p>}
            <p>{t.gmgnRequests(number(s.requests), number(s.recentRequests), number(s.historyRequests))}</p>
            <p className="gmgn-backfill">{t.gmgnBackfill(number(s.assetsWithHistory), number(s.backfillPending))}</p>
            <p>{t.gmgnCaveat}</p>
            <p>{t.gmgnUpdated(dateTime(s.updatedAt, t))}</p>
          </div>) : null)}
      </div>
    </section>}
    {display && <section className="panel rps-summary" aria-label={t.rpsSummaryTitle}>
      <div className="panel-heading"><h2>{t.rpsSummaryTitle}</h2>
        <span className={'rps-state rps-state-' + display.state}>{displayLabel}</span></div>
      <div className="rps-summary-body">
        <p>{t.rpsBaseline}<time dateTime={new Date(display.asOf).toISOString()}>{dateTime(display.asOf, t)}</time>{t.rpsPoolSize(display.poolSize)}</p>
        <p>{t.rpsComputedAt}<time dateTime={new Date(display.computedAt).toISOString()}>{dateTime(display.computedAt, t)}</time></p>
        {display.state !== 'current' && <p>{display.state === 'stale' ? t.rpsStaleNote : t.rpsPreviousNote}{t.rpsReferenceOnly}</p>}
      </div>
    </section>}
    {quality && !quality.rpsAvailable && display && (
      <div className="notice quality-notice"><span className="notice-symbol">!</span><div>
        <strong>{t.noTriggerTitle}</strong>
        <p>{display?.state === 'stale' ? t.noTriggerStale : t.noTriggerIncomplete}
          {' '}{t.noTriggerEndpoints(quality.freshPriceCount, number(collectingCount))}</p>
      </div></div>
    )}
    {quality && quality.rpsAvailable && (quality.rpsReadyKeys?.length ?? 0) < 5 && (
      <div className="notice"><span className="notice-symbol">i</span><div>
        <strong>{t.integrityTitle}</strong>
        <p>{t.integrityRanked(quality.rpsReadyKeys?.map((k) => k.toUpperCase()).join('、') || t.integrityNone)}
          {t.integrityBounded(quality.rpsBoundedKeys?.map((k) => k.toUpperCase()).join('、') || t.integrityNone)}
          {t.integrityNote}</p>
      </div></div>
    )}
    {coverage ? <section className="panel rps-coverage" aria-label={t.coverageTitle}>
      <div className="panel-heading"><h2>{t.coverageTitle}</h2><span>{t.coverageHint}</span></div>
      <div className="coverage-grid">{RPS_KEYS.map((key) => {
        const item = coverage[key];
        return <article className="coverage-card" key={key} aria-label={t.coverageAria(key.toUpperCase())}>
          <h3>{key.toUpperCase()}</h3><dl>
            <dt>{t.coverageAvailable}</dt><dd>{number(item?.available)} / {number(item?.eligible)}</dd>
            <dt>{t.coverageMissingCurrent}</dt><dd>{number(item?.missingCurrent)}</dd>
            <dt>{t.coverageMissingStart}</dt><dd>{number(item?.missingStart)}</dd>
            <dt>{t.coverageUnknownAge}</dt><dd>{number(item?.unknownAge)}</dd>
            <dt>{t.coverageInactive}</dt><dd>{number(item?.inactive)}</dd>
            <dt>{t.coverageAgeByHistory}</dt><dd>{number(item?.ageConfirmedByHistory)}</dd>
          </dl>
        </article>;
      })}</div><p className="coverage-note">{t.coverageNote(mainMinutes, revisionMinutes, inactiveHours)}</p>
    </section> : quality && <p className="rps-waiting">{t.coverageWaiting}</p>}
    <ErrorBox message={api.error} retry={api.reload} />
    <section className="panel"><div className="panel-heading"><h2>{t.assetsTitle}</h2><span>{t.assetsCount(rows.length, pools.length, api.data?.total ?? 0)}</span></div>
      <div className="filters"><label className="search-field"><span className="sr-only">{t.searchLabel}</span><input placeholder={t.searchPlaceholder} value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <label><span>{t.filterChain}</span><select aria-label={t.filterChain} value={chain} onChange={(e) => setChain(e.target.value)}><option value="">{t.filterAllChains}</option>{chains.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>{t.filterGroup}</span><select aria-label={t.filterGroup} value={group} onChange={(e) => setGroup(e.target.value)}><option value="">{t.filterAllGroups}</option>{groups.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>{t.filterSignal}</span><select aria-label={t.filterSignal} value={hit} onChange={(e) => setHit(e.target.value)}><option value="">{t.filterAllStates}</option><option value="1">{t.filterHit}</option><option value="0">{t.filterMiss}</option></select></label>
      </div>
      {api.loading ? <div className="loading" role="status">{t.loadingPool}</div> : <div className="table-scroll"><table className="pool-table"><thead><tr>
        {header(t.colSymbol, 'symbol')}{header(t.colCa, 'ca')}{header(t.colChain, 'chain')}{header(t.colMarketCap, 'marketCap')}{header(t.colLiquidity, 'liquidity')}
        <th>RPS <small>16 / 56 / 96 / 288 / 672</small></th><th>{t.colTags}</th>{header(t.colGroup, 'groupName')}
      </tr></thead><tbody>{rows.map((row) => <tr key={row.ca}>
        <td><a className="symbol-link" href={`/ca/${encodeURIComponent(row.ca)}`}>{row.symbol || t.unknownSymbol}</a></td><td><CopyCa ca={row.ca} /></td>
        <td><span className="chain-label">{row.chain || '—'}</span></td><td className="numeric">{money(row.marketCap)}</td><td className="numeric">{money(row.liquidity)}</td>
        <td><RpsCell row={row} /></td><td>{row.tags.length ? <Tags tags={row.tags} /> : <span className="muted">{t.waitingSignal}</span>}</td>
        <td className="group-name">{row.groupName || '—'}</td></tr>)}</tbody></table>
        {!rows.length && <Empty title={t.emptyAssetsTitle} description={t.emptyAssetsDesc} />}</div>}
    </section><p className="footnote">{t.overviewFootnote}</p>
  </>;
}

function AlertHistory() {
  const { t, lang } = useCopy();
  const [ca, setCa] = useState(''); const [tag, setTag] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [query, setQuery] = useState('');
  const api = useApi<AlertsResponse>(`/api/alerts?limit=200${query}`);
  const outcomes = useApi<OutcomesResponse>('/api/outcomes');
  return <><div className="page-heading"><div><p className="eyebrow">{t.alertsEyebrow}</p><h1>{t.alertsTitle}</h1><p>{t.alertsLead}</p></div><button onClick={api.reload}>{t.reload}</button></div>
    <section className="panel"><form className="filters alert-filters" onSubmit={(event) => { event.preventDefault();
      const params = new URLSearchParams(); if (ca.trim()) params.set('ca', ca.trim()); if (tag) params.set('tag', tag);
      if (from) params.set('from', String(new Date(from).getTime())); if (to) params.set('to', String(new Date(to).getTime()));
      setQuery(params.size ? `&${params}` : '');
    }}><label className="search-field"><span>{t.alertsCaLabel}</span><input placeholder={t.alertsCaPlaceholder} value={ca} maxLength={256} onChange={(e) => setCa(e.target.value)} /></label>
      <label><span>{t.alertsTagLabel}</span><select aria-label={t.alertsTagLabel} value={tag} onChange={(e) => setTag(e.target.value)}><option value="">{t.alertsAllTags}</option>
        {Object.entries(TAG_DETAILS).map(([key, detail]) => <option key={key} value={key}>{lang === 'en' ? detail.labelEn : detail.label}</option>)}</select></label>
      <label><span>{t.alertsFrom}</span><input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label><span>{t.alertsTo}</span><input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></label><button className="primary" type="submit">{t.alertsFilter}</button>
    </form></section><ErrorBox message={api.error} retry={api.reload} />
    <Outcomes data={outcomes.data} />
    <div className="section-heading"><h2>{t.alertsRecords}</h2><span>{t.alertsTotal(api.data?.total ?? 0)}</span></div>
    {api.loading ? <div className="loading" role="status">{t.loadingAlerts}</div> : api.data?.items.length
      ? <div className="alert-list">{api.data.items.map((item) => <AlertCard key={item.id} item={item} />)}</div>
      : <div className="panel"><Empty title={t.emptyAlertsTitle} description={t.emptyAlertsDesc} /></div>}
    {(api.data?.total ?? 0) > 200 && <p className="footnote">{t.alertsTruncated}</p>}
  </>;
}

function Detail({ ca, theme }: { ca: string; theme: string }) {
  const { t } = useCopy();
  const [period, setPeriod] = useState<Period>('30m');
  const api = useApi<DetailResponse>(`/api/ca/${encodeURIComponent(ca)}?interval=${period}&limit=300`);
  const data = api.data;
  const rsiByTime = new Map(data?.indicators.rsi.map((point) => [point.openTime, point.value]));
  const maByTime = new Map(data?.indicators.volumeMa.map((point) => [point.openTime, point.value]));
  const chain = data?.pool.chain?.toLowerCase();
  return <><a className="back-link" href="/">{t.backToPool}</a><div className="page-heading"><div><p className="eyebrow">{t.detailEyebrow}</p>
    <h1>{data?.pool.symbol || t.detailFallbackTitle} <span className="heading-chain">{data?.pool.chain}</span></h1><CopyCa ca={ca} full /></div><button onClick={api.reload}>{t.reload}</button></div>
    <ErrorBox message={api.error} retry={api.reload} />
    <div className="detail-grid"><section className="panel chart-panel"><div className="panel-heading"><h2>{t.chartTitle}</h2><div className="period-switch" aria-label={t.periodLabel}>
      {PERIODS.map((value) => <button key={value} className={value === period ? `selected period-border-${value}` : ''} aria-pressed={value === period}
        onClick={() => setPeriod(value)}><i className={`dot period-${value}`} />{value}</button>)}</div></div>
      {api.loading ? <div className="loading chart-loading" role="status">{t.loadingChart}</div> : data?.candles.length
        ? <PriceChart data={data} period={period} theme={theme} /> : <Empty title={t.emptyChartTitle} description={t.emptyChartDesc} />}
    </section><aside><section className="panel asset-info"><h2>{t.assetInfo}</h2><dl><dt>{t.fieldMarketCap}</dt><dd>{money(data?.pool.marketCap)}</dd>
      <dt>{t.fieldLiquidity}</dt><dd>{money(data?.pool.liquidity)}</dd><dt>{t.fieldVolume}</dt><dd>{money(data?.pool.volume24h)}</dd>
      <dt>{t.fieldSource}</dt><dd>{data?.marketSeries ? (data.marketSeries.source === 'gmgn' ? t.sourceGmgn
        : data.marketSeries.source === 'binance' ? t.sourceBinance : t.sourceGecko) : t.sourceWaiting}</dd>
      <dt>{t.fieldEarliestBar}</dt><dd>{dateTime(data?.historyStartedAt, t)}</dd>
      {data?.marketSeries?.source === 'geckoterminal' && data.marketSeries.poolAddress && <><dt>{t.fieldPinnedPair}</dt><dd><code className="series-address">{data.marketSeries.poolAddress}</code></dd></>}
      <dt>{t.fieldListedAt}</dt><dd>{dateTime(data?.pool.listedAt, t)}</dd><dt>{t.fieldFirstSeen}</dt><dd>{dateTime(data?.pool.firstSeenAt, t)}</dd>
      <dt>{t.fieldGroups}</dt><dd>{data?.pool.groupName || '—'}</dd><dt>{t.fieldLastMention}</dt><dd>{dateTime(data?.pool.latestMentionTime, t)}</dd></dl>
      <p className="muted">{t.historyCaveat}</p>
      <div className="external-links">
        {data?.marketSeries?.source === 'geckoterminal' && <a href={'https://www.geckoterminal.com/' + encodeURIComponent(data.marketSeries.network)
          + '/pools/' + encodeURIComponent(data.marketSeries.poolAddress)} target="_blank" rel="noreferrer">{t.linkPair}</a>}
        <a href={dexScreenerUrl(ca, chain)} target="_blank" rel="noreferrer">DexScreener ↗</a>
        {/* 此前直接把 chain 拼进 URL，但 GMGN 用 sol/eth 而非 solana/ethereum，
            导致 solana 与 ethereum 的链接全是坏的 —— 现由 links.ts 统一映射 */}
        {gmgnUrl(ca, chain) && <a href={gmgnUrl(ca, chain)!} target="_blank" rel="noreferrer">GMGN ↗</a>}</div></section>
      <section className="panel asset-info"><h2>{t.momentsTitle}</h2>{data?.moments.length ? <ol className="moments-list">{data.moments.map((moment) =>
        <li key={moment.moment}><strong>{t.momentLabel(moment.moment)}</strong><span>{dateTime(moment.barTime, t)}</span><code>{number(moment.price)}</code></li>)}</ol>
        : <p className="muted">{t.momentsEmpty}</p>}</section></aside></div>
    {data && <details className="panel data-table"><summary>{t.tableSummary(data.candles.length)}</summary><div className="table-scroll"><table>
      <thead><tr>{[t.colTime, t.colOpen, t.colHigh, t.colLow, t.colClose, t.colVolume, 'RSI', t.colVolMa(data.indicators.parameters.volMaPeriod)].map((label) => <th key={label}>{label}</th>)}</tr></thead>
      <tbody>{[...data.candles].reverse().map((bar) => <tr key={bar.openTime}><td>{dateTime(bar.openTime, t)}</td>
        {[bar.open, bar.high, bar.low, bar.close, bar.volume, rsiByTime.get(bar.openTime), maByTime.get(bar.openTime)].map((value, i) => <td className="numeric" key={i}>{number(value)}</td>)}</tr>)}</tbody>
    </table></div></details>}
    <div className="section-heading"><h2>{t.detailAlerts}</h2><a href="/alerts">{t.seeAllAlerts}</a></div>
    {data?.alerts.length ? <div className="alert-list">{data.alerts.map((item) => <AlertCard key={item.id} item={item} />)}</div>
      : <div className="panel"><Empty title={t.emptyDetailAlertsTitle} description={t.emptyDetailAlertsDesc} /></div>}
  </>;
}

interface SocialRow {
  ca: string; firedAt: number; symbol: string | null; chain: string | null;
  total: number | null; manufactured: number | null; botRatio: number | null;
  medianViews: number | null; kols: string[]; verdict: string | null;
}
interface SocialResponse {
  summary: { checked: number; manufactured: number; mixed: number; organic: number; quiet: number };
  comparison: { verdict: string; n: number; medianReturnPct: number | null }[];
  items: SocialRow[];
}

function SocialBoard() {
  const { t } = useCopy();
  const api = useApi<SocialResponse>('/api/social?limit=100');
  const label = (verdict: string | null): string =>
    verdict === 'manufactured' ? t.socialManufactured : verdict === 'mixed' ? t.socialMixed
      : verdict === 'organic' ? t.socialOrganic : t.socialQuiet;

  return <><div className="page-heading">
    <div><p className="eyebrow">{t.socialEyebrow}</p><h1>{t.socialTitle}</h1><p>{t.socialLead}</p></div>
    <button onClick={api.reload}>{t.reload}</button></div>
    <ErrorBox message={api.error} retry={api.reload} />

    {api.data && <section className="panel social-summary">
      {([['checked', t.socialChecked], ['manufactured', t.socialManufactured],
         ['mixed', t.socialMixed], ['organic', t.socialOrganic], ['quiet', t.socialQuiet]] as const)
        .map(([key, text]) => <div className="social-stat" key={key}>
          <span className="social-stat-value">{api.data!.summary[key as keyof SocialResponse['summary']]}</span>
          <span className="social-stat-label">{text}</span>
        </div>)}
    </section>}

    {api.data && api.data.comparison.length > 0 && <>
      <div className="section-heading"><h2>{t.socialComparisonTitle}</h2></div>
      <section className="panel"><p className="agent-privacy">{t.socialComparisonLead}</p>
        <table className="social-table"><thead><tr>
          <th>{t.socialColVerdict}</th><th>{t.socialColSamples}</th><th>{t.socialColMedian}</th>
        </tr></thead><tbody>
          {api.data.comparison.map((row) => <tr key={row.verdict}>
            <td>{label(row.verdict)}</td><td>{row.n}</td>
            <td className={row.medianReturnPct === null ? '' : row.medianReturnPct >= 0 ? 'gain' : 'loss'}>
              {row.medianReturnPct === null ? '—' : `${row.medianReturnPct >= 0 ? '+' : ''}${row.medianReturnPct.toFixed(1)}%`}</td>
          </tr>)}
        </tbody></table></section>
    </>}

    <div className="section-heading"><h2>{t.socialTitle}</h2></div>
    {api.loading ? <div className="loading" role="status">{t.socialLoading}</div>
      : api.data && api.data.items.length > 0
        ? <section className="panel"><div className="table-wrap"><table className="social-table"><thead><tr>
            <th>{t.socialColToken}</th><th>{t.socialColFired}</th><th>{t.socialColMentions}</th>
            <th>{t.socialColBot}</th><th>{t.socialColViews}</th><th>{t.socialColVerdict}</th><th>{t.socialColKol}</th>
          </tr></thead><tbody>
            {api.data.items.map((row) => <tr key={`${row.ca}-${row.firedAt}`}>
              <td><a className="symbol-link" href={`/ca/${encodeURIComponent(row.ca)}`}>{row.symbol || row.ca.slice(0, 8)}</a></td>
              <td>{new Date(row.firedAt).toISOString().slice(5, 16).replace('T', ' ')}</td>
              <td>{row.total ?? '—'}</td>
              <td className={(row.botRatio ?? 0) >= 0.6 ? 'loss' : ''}>
                {row.botRatio === null ? '—' : `${Math.round(row.botRatio * 100)}%`}</td>
              <td>{row.medianViews === null ? '—' : Math.round(row.medianViews)}</td>
              <td>{label(row.verdict)}</td>
              <td>{row.kols.length ? row.kols.join(', ') : '—'}</td>
            </tr>)}
          </tbody></table></div></section>
        : <Empty title={t.socialTitle} description={t.socialEmpty} />}
  </>;
}

function App() {
  const [theme, setTheme] = useState(initialTheme);
  const [lang, setLangState] = useState<Lang>(detectLang);
  const t = COPY[lang];
  const setLang = (next: Lang) => { persistLang(next); setLangState(next); };
  const stats = useApi<StatsResponse>('/api/stats');
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.scheme = import.meta.env.VITE_CANDLE_SCHEME === 'cn' ? 'cn' : 'intl';
    try { localStorage.setItem('alpha-theme', theme); } catch { /* 不依赖持久化 */ }
  }, [theme]);
  // lang 属性影响屏幕阅读器发音与断词，必须随语言切换同步更新。
  useLayoutEffect(() => { document.documentElement.lang = t.htmlLang; }, [t.htmlLang]);
  const path = window.location.pathname;
  let ca: string | null = null;
  if (path.startsWith('/ca/')) { try { ca = decodeURIComponent(path.slice(4)); } catch { /* 显示未找到 */ } }
  return <LangContext.Provider value={{ lang, t, setLang }}>
    <header className="site-header"><a className="brand" href="/" aria-label={t.brandHome}><span className="brand-icon">α</span><span>ALPHA<span className="brand-light"> / RESET</span></span></a>
    <nav aria-label={t.navMain}><a href="/" aria-current={path === '/' || ca !== null ? 'page' : undefined}>{t.navOverview}</a><a href="/alerts" aria-current={path === '/alerts' ? 'page' : undefined}>{t.navAlerts}</a><a href="/social" aria-current={path === '/social' ? 'page' : undefined}>{t.navSocial}</a><a href="/chat" aria-current={path === '/chat' ? 'page' : undefined}>{t.navChat}</a></nav>
    <div className="header-actions"><span className="local-label">{t.localBadge}</span>
      <button aria-label={t.langToggleLabel} onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}>{t.langToggle}</button>
      <button aria-label={t.themeLabel} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? t.themeDark : t.themeLight}</button></div></header>
    <main><ErrorBox message={stats.error} retry={stats.reload} />{path === '/' ? <Overview stats={stats.data} /> : path === '/alerts' ? <AlertHistory />
      : path === '/social' ? <SocialBoard /> : path === '/chat' ? <AgentPanel standalone /> : ca ? <Detail ca={ca} theme={theme} />
      : <Empty title={t.notFoundTitle} description={t.notFoundDesc} />}</main>
    <footer><span>ALPHA / RESET</span><span>{t.footerTagline}</span><span>{t.footerSources((stats.data?.dataQuality.enabledSources ?? ['geckoterminal']).map((source) => source === 'gmgn' ? 'GMGN' : source === 'binance' ? 'Binance Web3' : 'GeckoTerminal').join(' / '))}</span></footer>
  </LangContext.Provider>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
