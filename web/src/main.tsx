import { StrictMode, useLayoutEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AlertsResponse, DetailResponse, PoolResponse, PoolViewRow, StatsResponse } from '../../src/web/contracts.js';
import { PERIODS, TAG_DETAILS, type Period } from '../../src/market.js';
import { dateTime, money, number, relativeTime, useApi } from './api.js';
import { AlertCard, CopyCa, Empty, ErrorBox, RpsBars, Tags } from './components.js';
import { PriceChart } from './Chart.js';
import './style.css';

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
  return <><div className="page-heading"><div><p className="eyebrow">OBSERVATION DESK</p><h1>观察池</h1><p>追踪群组共识，等待新高后的回调。</p></div>
    <button onClick={api.reload}>↻ 刷新数据</button></div>
    <section className="stats-grid" aria-label="监控概览">
      <div className="stat-tile"><span>池内 CA</span><strong>{stats ? number(stats.poolSize) : '—'}</strong><small>观察组已收录的合约</small></div>
      <div className="stat-tile"><span>今日告警</span><strong>{stats ? number(stats.alertsToday) : '—'}</strong><small>成功推送 · 按合并消息计数</small></div>
      <div className="stat-tile"><span>API 配额</span><strong>{stats ? number(used) : '—'} <em>/ {stats ? number(limit) : '—'}</em></strong>
        <progress aria-label="API 已用配额" value={used} max={limit} className={used / limit * 100 >= (stats?.quotaWarningPercent ?? 100) ? 'quota-warning' : ''} /></div>
      <div className="stat-tile"><span>上次刷新</span><strong className="time-stat" title={dateTime(stats?.lastRunAt)}>{relativeTime(stats?.lastRunAt ?? null)}</strong>
        <small>{stats ? `策略每 ${stats.refreshMinutes} 分钟运行` : '等待数据服务'}</small></div>
    </section>
    {stats && (stats.dataQuality.roundRunning || !stats.dataQuality.rpsAvailable) && (
      <div className="notice quality-notice"><span className="notice-symbol">!</span><div>
        {stats.dataQuality.roundRunning ? <>
          <strong>本轮正在刷新</strong>
          <p>正在拉取 {stats.dataQuality.monitored} 个标的的行情，约需数分钟。
            期间 RPS 沿用上一轮结果。</p>
        </> : <>
          <strong>RPS 暂不可用</strong>
          <p>本轮各档覆盖率均未达标（需 ≥ {Math.round(stats.rpsMinCoverage * 100)}%），
            暂不生成 RPS 相关告警；其余标签不受影响。
            当前 {stats.dataQuality.freshPriceCount} / {stats.dataQuality.monitored} 个标的有最新价格。</p>
        </>}
      </div></div>
    )}
    {stats && stats.dataQuality.rpsAvailable && stats.dataQuality.rpsReadyKeys.length < 5 && (
      <div className="notice"><span className="notice-symbol">i</span><div>
        <strong>部分 RPS 档位未达标</strong>
        <p>已计分：{stats.dataQuality.rpsReadyKeys.map((k) => k.toUpperCase()).join('、')}。
          未达标的档位本轮不参与 A4 判定（五档为「或」关系，不影响告警产生）。</p>
      </div></div>
    )}
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
        <td><RpsBars scores={row.rpsScores} /></td><td>{row.tags.length ? <Tags tags={row.tags} /> : <span className="muted">等待信号</span>}</td>
        <td className="group-name">{row.groupName || '—'}</td></tr>)}</tbody></table>
        {!rows.length && <Empty title="暂无匹配资产" description="调整筛选条件，或等待调度完成首轮数据拉取。" />}</div>}
    </section><p className="footnote">RPS 对观察组全池排名；“—”表示历史不足、行情缺失或排名暂停。点击符号查看 K 线与新高时刻。</p>
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
  const chain = ({ solana: 'sol', sol: 'sol', eth: 'eth', ethereum: 'eth', bsc: 'bsc', base: 'base' } as Record<string, string>)[data?.pool.chain?.toLowerCase() ?? ''];
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
      <dt>上市时间（估算）</dt><dd>{dateTime(data?.pool.listedAt)}</dd><dt>首次观测</dt><dd>{dateTime(data?.pool.firstSeenAt)}</dd>
      <dt>提及群组</dt><dd>{data?.pool.groupName || '—'}</dd><dt>最近提及</dt><dd>{dateTime(data?.pool.latestMentionTime)}</dd></dl>
      <div className="external-links"><a href={`https://dexscreener.com/search?q=${encodeURIComponent(ca)}`} target="_blank" rel="noreferrer">DexScreener ↗</a>
        {chain && <a href={`https://gmgn.ai/${chain}/token/${encodeURIComponent(ca)}`} target="_blank" rel="noreferrer">GMGN ↗</a>}</div></section>
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
    <footer><span>ALPHA / RESET</span><span>观察组新高回调监控 · 历史数据持续累积</span><span>数据源：二娃 API</span></footer></>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
