import { StrictMode, useLayoutEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AlertsResponse, DetailResponse, PoolResponse, PoolViewRow, StatsResponse } from '../../src/web/contracts.js';
import { PERIODS, RPS_KEYS, TAG_DETAILS, type Period } from '../../src/market.js';
import { dateTime, money, number, relativeTime, useApi } from './api.js';
import { AlertCard, CopyCa, Empty, ErrorBox, RpsCell, Tags } from './components.js';
import { PriceChart } from './Chart.js';
import './style.css';
import { dexScreenerUrl, gmgnUrl } from './links.js';

function initialTheme() {
  try { const value = localStorage.getItem('alpha-theme'); if (value === 'light' || value === 'dark') return value; } catch { /* 存储不可用时仍可切换 */ }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function Overview({ stats }: { stats: StatsResponse | null }) {
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
  const collectingCount = collection?.memberCount ?? quality?.monitored ?? 0;
  const latestSweepMinutes = observation && collection?.effectiveRpm
    ? observation.memberCount / collection.effectiveRpm : null;
  const display = quality?.rpsDisplay;
  // 运行中的覆盖计数尚未完成，只展示最近已完成计算对应的覆盖。
  const coverage = display?.coverage ?? (quality?.rpsDisplay === undefined && !quality?.roundRunning ? quality?.rpsCoverage : null);
  const displayLabel = display?.state === 'previous' ? '上一轮评分' : display?.state === 'stale' ? '已过期评分' : '本轮评分';
  return <><div className="page-heading"><div><p className="eyebrow">OBSERVATION DESK</p><h1>观察池</h1><p>追踪群组共识，等待新高后的回调。</p></div>
    <button onClick={api.reload}>↻ 刷新数据</button></div>
    <section className="stats-grid" aria-label="监控概览">
      <div className="stat-tile"><span>池内 CA</span><strong>{stats ? number(stats.poolSize) : '—'}</strong><small>最新完整观察名单</small></div>
      <div className="stat-tile"><span>今日告警</span><strong>{stats ? number(stats.alertsToday) : '—'}</strong><small>成功推送 · 按合并消息计数</small></div>
      <div className="stat-tile"><span>API 配额</span><strong>{stats ? number(used) : '—'} <em>/ {stats ? number(limit) : '—'}</em></strong>
        <progress aria-label="API 已用配额" value={used} max={limit} className={used / limit * 100 >= (stats?.quotaWarningPercent ?? 100) ? 'quota-warning' : ''} /></div>
      <div className="stat-tile"><span>名单刷新</span><strong className="time-stat" title={dateTime(stats?.lastRunAt)}>{relativeTime(stats?.lastRunAt ?? null)}</strong>
        <small>{observation ? `名单每 ${observation.refreshMinutes} 分钟刷新` : stats ? `策略每 ${stats.refreshMinutes} 分钟运行` : '等待数据服务'}</small></div>
    </section>
    {observation && <section className="panel observation-summary" aria-label="最新观察名单">
      <div className="panel-heading"><h2>最新观察名单</h2><span>来源去重 {number(observation.sourceCount)} 个 · 已纳入 {number(observation.memberCount)} 个</span></div>
      <div className="observation-summary-body">
        <p>名单更新：{observation.updatedAt === null ? '等待完整发现' : <time dateTime={new Date(observation.updatedAt).toISOString()}>{dateTime(observation.updatedAt)}</time>} · 每 {observation.refreshMinutes} 分钟发现一次</p>
        {observation.discoveryStatus && observation.discoveryStatus !== 'complete' && <p className={'discovery-status discovery-' + observation.discoveryStatus} role="status">
          {observation.discoveryStatus === 'running' ? '名单正在刷新'
            : observation.discoveryStatus === 'failed' ? `名单刷新失败（${observation.discoveryFailures ?? 0} 项）`
            : observation.discoveryStatus === 'halted' ? '名单刷新暂停'
            : `名单已更新，本次有 ${observation.discoveryFailures ?? 0} 项附加请求失败`}
          {observation.discoveryStatus !== 'partial' && (observation.updatedAt === null ? '，尚无已完成名单。' : '，继续展示上次成功取得的完整名单。')}
          {observation.lastAttemptAt != null && <> 最近尝试：<time dateTime={new Date(observation.lastAttemptAt).toISOString()}>{dateTime(observation.lastAttemptAt)}</time></>}
        </p>}
        {observation.addedCount !== undefined && observation.removedCount !== undefined
          && <p>最近新增 {observation.addedCount} · 移出 {observation.removedCount}</p>}
        {calculation && <p className="calculation-summary">当前计算池 {number(calculation.memberCount)} 个 CA · 收盘基准：{dateTime(calculation.asOf)}。新成员等待纳入后续固定时点计算。</p>}
        {latestSweepMinutes !== null && <p className="sweep-estimate">若最新名单全部由 GeckoTerminal 采集，按当前上限 {number(collection?.effectiveRpm)} 次/分钟，最新名单扫描至少 {number(latestSweepMinutes)} 分钟；网络响应与重试会延长。</p>}
        {observation.upstreamLimited && <p className="observation-limited">上游每群最多返回 200 个；当前结果已触顶，名单可能仍有截断。全量纳入指当前上游返回的去重名单。</p>}
      </div>
    </section>}
    {quality?.roundRunning && (
      <div className="notice collection-notice" role="status"><span className="notice-symbol">i</span><div>
        <strong>GeckoTerminal · 本轮行情采集中</strong>
        {collection?.boardComplete === false ? <p>正在读取观察池，完成后开始采集行情。</p>
          : collection ? <>
            {observation && <p>本采集轮 {number(collectingCount)} 个标的 · 最新观察名单 {number(observation.memberCount)} 个；名单发现与行情遍历独立进行。</p>}
            <p>已处理 {collection.processed} / {collectingCount} 个标的 · 成功 {collection.succeeded} · 失败 {collection.failed}</p>
            <progress aria-label="本轮行情采集进度" value={collection.processed} max={Math.max(collectingCount, 1)} />
            <p>固定端点已到位 {quality.freshPriceCount} / {collectingCount} · 已有历史 {collection.historyAvailable} 个</p>
            {collection.minSweepMinutes !== undefined && <p>按当前限流，本采集轮扫描至少 {number(collection.minSweepMinutes)} 分钟；不含网络和重试耗时。</p>}
            <p>本轮价格基准：{dateTime(collection.baselineAt)}</p>
          </> : <p>正在采集 {quality.monitored} 个标的的行情，等待本轮计算完成。</p>}
        <p>{!display && '尚无已完成的评分，等待本轮计算。'}RPS 每 {mainMinutes} 分钟建立新一轮；有新数据时，同一时点每 {revisionMinutes} 分钟最多补算一次。结果通过 WebSocket 自动显示，持续采集不会清空历史评分。</p>
      </div></div>
    )}
    {(calculation?.sources || gmgn?.enabled) && <section className="panel market-sources" aria-label="评分来源与采集状态">
      <div className="panel-heading"><h2>评分来源与采集状态</h2><span>各来源独立限速与积累历史</span></div>
      <div className="market-sources-body">
        {calculation?.sources && <p className="scoring-sources">本轮正式评分来源：GMGN {number(calculation.sources.gmgn)} 个 · GeckoTerminal {number(calculation.sources.geckoterminal)} 个 · 未绑定 {number(calculation.sources.unbound)} 个。<br />按收盘基准 {dateTime(calculation.asOf)} 的实际序列统计，绑定来源不代表五档数据已齐。</p>}
        {gmgn?.enabled && <div className="gmgn-status" role="status" data-status={gmgn.status ?? 'waiting'}>
          <p><strong>GMGN · {gmgn.status === 'running' ? '采集中' : gmgn.status === 'cooldown' ? '限流冷却'
            : gmgn.status === 'auth_error' ? '鉴权失败，采集暂停' : gmgn.status === 'disabled' ? '采集未启动'
            : gmgn.status === 'idle' ? '等待下次采集' : '等待采集器状态'}</strong> · 限速上限 {number(gmgn.effectiveRpm)} 次/分钟</p>
          {gmgn.status === 'cooldown' && gmgn.cooldownUntil > 0 && <p>最早恢复时间：{dateTime(gmgn.cooldownUntil)}；恢复后仍按限速处理。</p>}
          <p>累计采集任务 {number(gmgn.requests)} 次 · 近期行情 {number(gmgn.recentRequests)} 次 · 历史分段 {number(gmgn.historyRequests)} 次</p>
          <p className="gmgn-backfill">历史范围已查询 {number(gmgn.assetsWithHistory)} 个 · 队列内待回补 {number(gmgn.backfillPending)} 个</p>
          <p>历史范围已查询不代表连续 K 线完整；无交易时段、缺失端点仍可能使部分评分等待。待回补仅统计已进入采集队列的资产。</p>
          <p>状态更新：{dateTime(gmgn.updatedAt)}。任务次数不含内部重试；网络重试仍占用限速预算。两路进度不能直接相加为全池已采齐。</p>
        </div>}
      </div>
    </section>}
    {display && <section className="panel rps-summary" aria-label="RPS 评分状态">
      <div className="panel-heading"><h2>最近已完成的 RPS 计算</h2>
        <span className={'rps-state rps-state-' + display.state}>{displayLabel}</span></div>
      <div className="rps-summary-body">
        <p>收盘基准：<time dateTime={new Date(display.asOf).toISOString()}>{dateTime(display.asOf)}</time> · 原观察池 {display.poolSize} 个 CA</p>
        <p>计算完成：<time dateTime={new Date(display.computedAt).toISOString()}>{dateTime(display.computedAt)}</time></p>
        {display.state !== 'current' && <p>{display.state === 'stale' ? '评分已过期' : '正在展示上一轮评分'}，仅供参考，不参与本轮规则或新标签。</p>}
      </div>
    </section>}
    {quality && !quality.rpsAvailable && display && (
      <div className="notice quality-notice"><span className="notice-symbol">!</span><div>
        <strong>本轮尚无可用于触发的 RPS</strong>
        <p>{display?.state === 'stale' ? '显示的历史评分已过期，等待新的计算结果。'
          : '尚无完整排名或能够确认达标的下界，等待补足数据。'}
          GeckoTerminal 本采集轮固定端点已到位 {quality.freshPriceCount} / {collectingCount} 个标的。</p>
      </div></div>
    )}
    {quality && quality.rpsAvailable && (quality.rpsReadyKeys?.length ?? 0) < 5 && (
      <div className="notice"><span className="notice-symbol">i</span><div>
        <strong>RPS 数据完整性</strong>
        <p>完整排名：{quality.rpsReadyKeys?.map((k) => k.toUpperCase()).join('、') || '暂无'}。
          保守下界可确认达标：{quality.rpsBoundedKeys?.map((k) => k.toUpperCase()).join('、') || '暂无'}。
          五档任一项确定通过即可满足 A4；范围跨过阈值时等待补数。</p>
      </div></div>
    )}
    {coverage ? <section className="panel rps-coverage" aria-label="五档 RPS 覆盖明细">
      <div className="panel-heading"><h2>五档覆盖明细</h2><span>最近已完成计算的覆盖</span></div>
      <div className="coverage-grid">{RPS_KEYS.map((key) => {
        const item = coverage[key];
        return <article className="coverage-card" key={key} aria-label={key.toUpperCase() + ' 覆盖'}>
          <h3>{key.toUpperCase()}</h3><dl>
            <dt>有效 / 潜在适龄</dt><dd>{number(item?.available)} / {number(item?.eligible)}</dd>
            <dt>缺当前端点</dt><dd>{number(item?.missingCurrent)}</dd>
            <dt>缺起点</dt><dd>{number(item?.missingStart)}</dd>
            <dt>未知年龄</dt><dd>{number(item?.unknownAge)}</dd>
            <dt>失活剔除</dt><dd>{number(item?.inactive)}</dd>
            <dt>历史证明适龄</dt><dd>{number(item?.ageConfirmedByHistory)}</dd>
          </dl>
        </article>;
      })}</div><p className="coverage-note">每 {mainMinutes} 分钟按固定时点计算；迟到数据最多每 {revisionMinutes} 分钟补算一次，仍修订同一时点。覆盖未达门槛时，区间仅供观察，不触发规则。“历史证明适龄”不代表已知首次上市时间。“失活剔除”是基准前 {inactiveHours} 小时内无任何成交的成员，已不计入排名分母。</p>
    </section> : quality && <p className="rps-waiting">暂无已完成的覆盖统计，等待本轮计算。</p>}
    <ErrorBox message={api.error} retry={api.reload} />
    <section className="panel"><div className="panel-heading"><h2>观察组资产</h2><span>{rows.length} 条匹配 · 已载入 {pools.length} / {api.data?.total ?? 0}</span></div>
      <div className="filters"><label className="search-field"><span className="sr-only">搜索符号或 CA</span><input placeholder="搜索符号或 CA…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <label><span>链</span><select aria-label="链" value={chain} onChange={(e) => setChain(e.target.value)}><option value="">全部链</option>{chains.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>群组</span><select aria-label="群组" value={group} onChange={(e) => setGroup(e.target.value)}><option value="">全部群组</option>{groups.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>信号</span><select aria-label="信号" value={hit} onChange={(e) => setHit(e.target.value)}><option value="">全部状态</option><option value="1">已命中</option><option value="0">未命中</option></select></label>
      </div>
      {api.loading ? <div className="loading" role="status">正在读取观察池…</div> : <div className="table-scroll"><table className="pool-table"><thead><tr>
        {header('符号', 'symbol')}{header('CA', 'ca')}{header('链', 'chain')}{header('市值', 'marketCap')}{header('流动性', 'liquidity')}
        <th>RPS <small>16 / 56 / 96 / 288 / 672</small></th><th>命中标签</th>{header('最近提及群', 'groupName')}
      </tr></thead><tbody>{rows.map((row) => <tr key={row.ca}>
        <td><a className="symbol-link" href={`/ca/${encodeURIComponent(row.ca)}`}>{row.symbol || '未知符号'}</a></td><td><CopyCa ca={row.ca} /></td>
        <td><span className="chain-label">{row.chain || '—'}</span></td><td className="numeric">{money(row.marketCap)}</td><td className="numeric">{money(row.liquidity)}</td>
        <td><RpsCell row={row} /></td><td>{row.tags.length ? <Tags tags={row.tags} /> : <span className="muted">等待信号</span>}</td>
        <td className="group-name">{row.groupName || '—'}</td></tr>)}</tbody></table>
        {!rows.length && <Empty title="暂无匹配资产" description="调整筛选条件，或等待调度完成首轮数据拉取。" />}</div>}
    </section><p className="footnote">RPS 使用统一收盘时点；数字为完整排名，“≥”为可证明下界，数值区间表示尚待确认的范围；“—”为数据不足。上一轮与已过期评分仅供参考。点击符号查看行情来源与已覆盖历史。</p>
  </>;
}

function AlertHistory() {
  const [ca, setCa] = useState(''); const [tag, setTag] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [query, setQuery] = useState('');
  const api = useApi<AlertsResponse>(`/api/alerts?limit=200${query}`);
  return <><div className="page-heading"><div><p className="eyebrow">SIGNAL JOURNAL</p><h1>告警历史</h1><p>每一次触发，都保留当时的指标快照。</p></div><button onClick={api.reload}>↻ 刷新数据</button></div>
    <section className="panel"><form className="filters alert-filters" onSubmit={(event) => { event.preventDefault();
      const params = new URLSearchParams(); if (ca.trim()) params.set('ca', ca.trim()); if (tag) params.set('tag', tag);
      if (from) params.set('from', String(new Date(from).getTime())); if (to) params.set('to', String(new Date(to).getTime()));
      setQuery(params.size ? `&${params}` : '');
    }}><label className="search-field"><span>合约地址</span><input placeholder="输入完整 CA" value={ca} maxLength={256} onChange={(e) => setCa(e.target.value)} /></label>
      <label><span>标签</span><select aria-label="标签" value={tag} onChange={(e) => setTag(e.target.value)}><option value="">全部标签</option>
        {Object.entries(TAG_DETAILS).map(([key, detail]) => <option key={key} value={key}>{detail.label}</option>)}</select></label>
      <label><span>开始时间（本地）</span><input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label><span>结束时间（本地）</span><input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></label><button className="primary" type="submit">筛选记录</button>
    </form></section><ErrorBox message={api.error} retry={api.reload} />
    <div className="section-heading"><h2>触发记录</h2><span>共 {api.data?.total ?? 0} 条合并消息</span></div>
    {api.loading ? <div className="loading" role="status">正在读取告警…</div> : api.data?.items.length
      ? <div className="alert-list">{api.data.items.map((item) => <AlertCard key={item.id} item={item} />)}</div>
      : <div className="panel"><Empty title="暂无告警记录" description="满足策略条件后，合并标签和指标快照会出现在这里。" /></div>}
    {(api.data?.total ?? 0) > 200 && <p className="footnote">显示最新 200 条，请通过时间范围继续查询历史记录。</p>}
  </>;
}

function Detail({ ca, theme }: { ca: string; theme: string }) {
  const [period, setPeriod] = useState<Period>('30m');
  const api = useApi<DetailResponse>(`/api/ca/${encodeURIComponent(ca)}?interval=${period}&limit=300`);
  const data = api.data;
  const rsiByTime = new Map(data?.indicators.rsi.map((point) => [point.openTime, point.value]));
  const maByTime = new Map(data?.indicators.volumeMa.map((point) => [point.openTime, point.value]));
  const chain = data?.pool.chain?.toLowerCase();
  return <><a className="back-link" href="/">← 返回观察池</a><div className="page-heading"><div><p className="eyebrow">ASSET OBSERVATION</p>
    <h1>{data?.pool.symbol || '代币详情'} <span className="heading-chain">{data?.pool.chain}</span></h1><CopyCa ca={ca} full /></div><button onClick={api.reload}>↻ 刷新数据</button></div>
    <ErrorBox message={api.error} retry={api.reload} />
    <div className="detail-grid"><section className="panel chart-panel"><div className="panel-heading"><h2>价格与量能</h2><div className="period-switch" aria-label="K 线周期">
      {PERIODS.map((value) => <button key={value} className={value === period ? `selected period-border-${value}` : ''} aria-pressed={value === period}
        onClick={() => setPeriod(value)}><i className={`dot period-${value}`} />{value}</button>)}</div></div>
      {api.loading ? <div className="loading chart-loading" role="status">正在读取 K 线…</div> : data?.candles.length
        ? <PriceChart data={data} period={period} theme={theme} /> : <Empty title="该周期暂无可用 K 线" description="数据源未提供完整行情，或数据未通过校验；系统会继续积累历史。" />}
    </section><aside><section className="panel asset-info"><h2>资产信息</h2><dl><dt>市值</dt><dd>{money(data?.pool.marketCap)}</dd>
      <dt>流动性</dt><dd>{money(data?.pool.liquidity)}</dd><dt>24h 成交量</dt><dd>{money(data?.pool.volume24h)}</dd>
      <dt>行情来源</dt><dd>{data?.marketSeries ? (data.marketSeries.source === 'gmgn' ? 'GMGN · USD · 代币 K 线' : 'GeckoTerminal · USD · 固定交易对') : '等待验证'}</dd>
      <dt>最早已存 K 线</dt><dd>{dateTime(data?.historyStartedAt)}</dd>
      {data?.marketSeries?.source === 'geckoterminal' && data.marketSeries.poolAddress && <><dt>固定交易对</dt><dd><code className="series-address">{data.marketSeries.poolAddress}</code></dd></>}
      <dt>上市时间（估算）</dt><dd>{dateTime(data?.pool.listedAt)}</dd><dt>首次观测</dt><dd>{dateTime(data?.pool.firstSeenAt)}</dd>
      <dt>提及群组</dt><dd>{data?.pool.groupName || '—'}</dd><dt>最近提及</dt><dd>{dateTime(data?.pool.latestMentionTime)}</dd></dl>
      <p className="muted">历史新高仅比较本序列已存数据；最早 K 线不保证之后每个时段连续，缺失时段与更早历史仍待补齐。</p>
      <div className="external-links">
        {data?.marketSeries?.source === 'geckoterminal' && <a href={'https://www.geckoterminal.com/' + encodeURIComponent(data.marketSeries.network)
          + '/pools/' + encodeURIComponent(data.marketSeries.poolAddress)} target="_blank" rel="noreferrer">采集交易对 ↗</a>}
        <a href={dexScreenerUrl(ca, chain)} target="_blank" rel="noreferrer">DexScreener ↗</a>
        {/* 此前直接把 chain 拼进 URL，但 GMGN 用 sol/eth 而非 solana/ethereum，
            导致 solana 与 ethereum 的链接全是坏的 —— 现由 links.ts 统一映射 */}
        {gmgnUrl(ca, chain) && <a href={gmgnUrl(ca, chain)!} target="_blank" rel="noreferrer">GMGN ↗</a>}</div></section>
      <section className="panel asset-info"><h2>已记录的新高时刻</h2>{data?.moments.length ? <ol className="moments-list">{data.moments.map((moment) =>
        <li key={moment.moment}><strong>时刻 {moment.moment}</strong><span>{dateTime(moment.barTime)}</span><code>{number(moment.price)}</code></li>)}</ol>
        : <p className="muted">等待新的突破时刻</p>}</section></aside></div>
    {data && <details className="panel data-table"><summary>K 线数据表 · {data.candles.length} 根（图表的无障碍替代）</summary><div className="table-scroll"><table>
      <thead><tr>{['时间', '开盘', '最高', '最低', '收盘', '成交量', 'RSI', `量 MA${data.indicators.parameters.volMaPeriod}`].map((label) => <th key={label}>{label}</th>)}</tr></thead>
      <tbody>{[...data.candles].reverse().map((bar) => <tr key={bar.openTime}><td>{dateTime(bar.openTime)}</td>
        {[bar.open, bar.high, bar.low, bar.close, bar.volume, rsiByTime.get(bar.openTime), maByTime.get(bar.openTime)].map((value, i) => <td className="numeric" key={i}>{number(value)}</td>)}</tr>)}</tbody>
    </table></div></details>}
    <div className="section-heading"><h2>该资产最近告警</h2><a href="/alerts">查看全部记录 →</a></div>
    {data?.alerts.length ? <div className="alert-list">{data.alerts.map((item) => <AlertCard key={item.id} item={item} />)}</div>
      : <div className="panel"><Empty title="尚未触发告警" description="新高时刻被记录后，系统会等待符合配置的回调条件。" /></div>}
  </>;
}

function App() {
  const [theme, setTheme] = useState(initialTheme);
  const stats = useApi<StatsResponse>('/api/stats');
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.scheme = import.meta.env.VITE_CANDLE_SCHEME === 'cn' ? 'cn' : 'intl';
    try { localStorage.setItem('alpha-theme', theme); } catch { /* 不依赖持久化 */ }
  }, [theme]);
  const path = window.location.pathname;
  let ca: string | null = null;
  if (path.startsWith('/ca/')) { try { ca = decodeURIComponent(path.slice(4)); } catch { /* 显示未找到 */ } }
  return <><header className="site-header"><a className="brand" href="/" aria-label="Alpha-Reset 首页"><span className="brand-icon">α</span><span>ALPHA<span className="brand-light"> / RESET</span></span></a>
    <nav aria-label="主导航"><a href="/" aria-current={path === '/' || ca !== null ? 'page' : undefined}>观察池</a><a href="/alerts" aria-current={path === '/alerts' ? 'page' : undefined}>告警历史</a></nav>
    <div className="header-actions"><span className="local-label">◉ 本地数据</span><button aria-label="切换明暗主题" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? '☾ 深色' : '☀ 浅色'}</button></div></header>
    <main><ErrorBox message={stats.error} retry={stats.reload} />{path === '/' ? <Overview stats={stats.data} /> : path === '/alerts' ? <AlertHistory /> : ca ? <Detail ca={ca} theme={theme} />
      : <Empty title="页面未找到" description="通过顶部导航返回观察池或告警历史。" />}</main>
    <footer><span>ALPHA / RESET</span><span>观察组新高回调监控 · 历史数据持续累积</span><span>群数据：二娃 · 行情：{(stats.data?.dataQuality.enabledSources ?? ['geckoterminal']).map((source) => source === 'gmgn' ? 'GMGN' : 'GeckoTerminal').join(' / ')}</span></footer></>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
