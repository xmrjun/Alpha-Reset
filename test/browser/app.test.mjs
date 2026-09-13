import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { preview } from 'vite';
import { chromium, expect } from '@playwright/test';

let server;
let browser;
let origin;
const now = Date.parse('2026-09-11T12:00:00Z');
const tags = ['30m_ath_pullback', 'low_vol_60m', 'rsi_lt50_4h'];
const rpsKeys = ['r16', 'r56', 'r96', 'r288', 'r672'];
const noScores = Object.fromEntries(rpsKeys.map((key) => [key, null]));
const completedCoverage = Object.fromEntries(rpsKeys.map((key) => [key, {
  eligible: 132, available: 126, complete: false, source: 'kline', unknownAge: 2,
  missingCurrent: 3, missingStart: 1, inactive: 9, ageConfirmedByHistory: 8, boundedPassCount: 5,
}]));
const pendingCoverage = Object.fromEntries(rpsKeys.map((key) => [key, {
  eligible: 0, available: 0, complete: false, source: 'kline', unknownAge: 0,
  missingCurrent: 0, missingStart: 0, inactive: 0, ageConfirmedByHistory: 0, boundedPassCount: 0,
}]));
const poolItem = (ca, symbol, chain, marketCap) => ({ ca, symbol, chain, marketCap, liquidity: 85_000,
  volume24h: 123_000, groupName: chain === 'bsc' ? '示例群组二' : '示例群组一', latestMentionTime: now - 60_000,
  tokenName: symbol, firstSeenAt: now - 86_400_000, listedAt: now - 7 * 86_400_000, updatedAt: now,
  rpsScores: { r16: 92, r56: 76, r96: 89, r288: 64, r672: null }, tags: ca === 'asset-a' ? tags : [],
  reasons: { a1: true, a2: true, a3: true, a4: true }, lastAlertAt: ca === 'asset-a' ? now : null });
const items = [poolItem('asset-a', 'ALPHA', 'solana', 1_250_000), poolItem('asset-b', 'BETA', 'bsc', 750_000)];
const alert = { id: 1, ca: 'asset-a', firedAt: now - 3_600_000, tags,
  payload: { rpsScores: items[0].rpsScores, dryRun: false }, pushed: true };

before(async () => {
  server = await preview({ configFile: fileURLToPath(new URL('../../web/vite.config.ts', import.meta.url)),
    preview: { host: '127.0.0.1', port: 0, strictPort: true } });
  const address = server.httpServer.address();
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await new Promise((resolve) => server?.httpServer.close(resolve)); });

async function pageFixture(t, mobile = false, locale = 'zh-CN') {
  // 页面按浏览器语言选择中英文；既有断言都是中文，这里固定 zh-CN，英文另有专门用例。
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1050 }, colorScheme: 'light', timezoneId: 'UTC', locale });
  t.after(() => context.close());
  const page = await context.newPage();
  // 所有测试均使用浏览器内的 WebSocket 替身，不连接本地预览或任何上游。
  await page.addInitScript(() => {
    window.__liveSockets = [];
    class MockWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        super();
        this.url = String(url);
        this.readyState = MockWebSocket.CONNECTING;
        window.__liveSockets.push(this);
        queueMicrotask(() => {
          if (this.readyState !== MockWebSocket.CONNECTING) return;
          this.readyState = MockWebSocket.OPEN;
          this.dispatchEvent(new Event('open'));
        });
      }
      send() {}
      close() {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close', { code: 1001, reason: 'mock disconnect' }));
      }
    }
    window.WebSocket = MockWebSocket;
  });
  const errors = [];
  const requests = [];
  const responses = new Map();
  const heldPoolResponses = [];
  const state = { failPool: false, empty: false, bounded: false, cached: false, running: false,
    stale: false, firstRound: false, boardComplete: true, processed: 2, succeeded: 1, failed: 1, fresh: 1, holdPool: false };
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()); requests.push(url);
    let body;
    const displayMeta = { state: state.stale ? 'stale' : state.running ? 'previous' : 'current',
      asOf: now - 1_800_000, computedAt: now - 1_200_000, poolSize: 132 };
    const currentAllowed = !state.running && !state.stale && !state.firstRound;
    if (url.pathname === '/api/stats') body = { poolSize: 2, alertsToday: 1, quota: { used: 420, limit: 10_500 },
      lastRunAt: now, refreshMinutes: 30, quotaWarningPercent: 85,
      rpsMinCoverage: 0.75,
      dataQuality: { mayBeTruncated: false, freshPriceCount: state.running ? state.fresh : 2, monitored: 2, observeGroups: 3,
        rpsAvailable: currentAllowed, rpsReadyKeys: !currentAllowed || state.bounded ? [] : ['r16', 'r56', 'r96', 'r288'],
        rpsBoundedKeys: currentAllowed && state.bounded ? ['r16'] : [], roundStatus: state.running ? 'running' : 'complete',
        rpsFromPreviousRound: state.running && state.cached, roundRunning: state.running,
        rpsCoverage: state.running || state.firstRound ? pendingCoverage : state.cached ? completedCoverage : null,
        ...(state.cached || state.firstRound ? { rpsDisplay: state.firstRound ? null : { ...displayMeta, coverage: completedCoverage } } : {}),
        collection: { boardComplete: state.boardComplete, baselineAt: now, processed: state.processed,
          succeeded: state.succeeded, failed: state.failed, historyAvailable: state.firstRound ? state.succeeded : 2 },
      } };
    else if (url.pathname === '/api/pool') {
      if (state.failPool) return route.fulfill({ status: 503, json: { error: 'UNAVAILABLE' } });
      const scored = state.bounded ? items.map((item) => ({ ...item,
        rpsScores: { ...item.rpsScores, r16: null, r96: null },
        rpsBounds: { r16: { lower: 86, upper: 96, status: 'pass' },
          r96: { lower: 80, upper: 90, status: 'unknown' }, r56: null, r288: null, r672: null },
      })) : items;
      body = { items: state.empty ? [] : scored.map((item) => ({ ...item,
        ...(!currentAllowed ? { rpsScores: noScores, rpsBounds: undefined, tags: [],
          reasons: { ...item.reasons, a4: false } } : {}),
        ...(state.firstRound ? { displayRps: null } : state.cached ? {
          displayRps: { ...displayMeta, scores: item.rpsScores, bounds: item.rpsBounds },
        } : {}),
      })), total: state.empty ? 0 : 2, updatedAt: now };
    } else if (url.pathname === '/api/alerts') body = { items: [alert], total: 1 };
    else if (url.pathname === '/api/ca/asset-a') {
      const ms = { '30m': 1_800_000, '60m': 3_600_000, '4h': 14_400_000 }[url.searchParams.get('interval')];
      const candles = Array.from({ length: 70 }, (_, i) => ({ openTime: now - (70 - i) * ms,
        open: 10 + i / 10, close: 10 + i / 10 + (i % 2 ? -.1 : .2), high: 10.5 + i / 10, low: 9.5 + i / 10, volume: 1000 + i * 10 }));
      body = { pool: items[0], candles,
        ...(state.detailGmgn ? { marketSeries: { id: 'gmgn-a', source: 'gmgn', scope: 'token', network: 'solana',
          ca: 'asset-a', poolAddress: null, currency: 'usd', formatVersion: 1, active: true,
          createdAt: now, activatedAt: now }, historyStartedAt: candles[0].openTime } : {}),
        indicators: { rsi: candles.slice(14).map((bar, i) => ({ openTime: bar.openTime, value: 45 + Math.sin(i / 4) * 15 })),
        volumeMa: candles.slice(38).map((bar) => ({ openTime: bar.openTime, value: 1300 })),
        parameters: { rsiPeriod: 14, volMaPeriod: 39, rsiBelow: 50, maxRsi: 60 } },
        moments: [{ moment: 1, barTime: candles[50].openTime, price: candles[50].high }], alerts: [alert] };
    } else return route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } });
    responses.set(url.pathname, structuredClone(body));
    if (state.holdPool && url.pathname === '/api/pool') {
      await new Promise((resolve) => heldPoolResponses.push(resolve));
    }
    return route.fulfill({ status: 200, json: body });
  });
  const snapshot = (revision) => ({ type: 'snapshot', revision,
    stats: structuredClone(responses.get('/api/stats')), pool: structuredClone(responses.get('/api/pool')) });
  return { page, errors, requests, state, snapshot, heldPoolResponses };
}

test('观察池搜索、链筛选、列排序、明暗切换和导航可用', async (t) => {
  const { page, errors } = await pageFixture(t);
  await page.goto(origin);
  await expect(page.getByRole('link', { name: 'ALPHA', exact: true })).toBeVisible();
  await page.getByLabel('链', { exact: true }).selectOption('bsc');
  await expect(page.getByRole('link', { name: 'ALPHA', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'BETA', exact: true })).toBeVisible();
  await page.getByLabel('链', { exact: true }).selectOption('');
  await page.getByRole('button', { name: '市值' }).click();
  await expect(page.locator('tbody tr').first()).toContainText('BETA');
  await page.getByPlaceholder('搜索符号或 CA…').fill('ALPHA');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  if (process.env.WEB_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.WEB_SCREENSHOT_DIR, 'alpha-overview.png'), fullPage: true });
  await page.getByRole('button', { name: '切换明暗主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  assert.deepEqual(errors, []);
});

test('详情真实渲染多副图，周期切换、告警标记、数据表及深色模式可用', async (t) => {
  const { page, errors, requests } = await pageFixture(t);
  await page.goto(`${origin}/ca/asset-a`);
  await expect(page.getByRole('heading', { name: 'ALPHA solana' })).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();
  assert.ok(await page.locator('canvas').count() >= 6);
  await expect(page.locator('.chart-alert-line')).toHaveCount(1);
  await page.getByRole('button', { name: '60m', exact: true }).click();
  await expect(page.getByRole('button', { name: '60m', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('canvas').first()).toBeVisible();
  await expect(page.locator('.chart-alert-line')).toHaveCount(1);
  assert.ok(requests.some((url) => url.searchParams.get('interval') === '60m'));
  await page.locator('.data-table > summary').click();
  await expect(page.locator('.data-table tbody tr')).toHaveCount(70);
  await page.getByRole('button', { name: '切换明暗主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('canvas').first()).toBeVisible();
  if (process.env.WEB_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.WEB_SCREENSHOT_DIR, 'alpha-detail-dark.png') });
  assert.deepEqual(errors, []);
});

test('移动端告警筛选、合并标签与快照，页面无水平溢出', async (t) => {
  const { page, errors, requests } = await pageFixture(t, true);
  await page.goto(`${origin}/alerts`);
  await expect(page.locator('.alert-card')).toHaveCount(1);
  await expect(page.locator('.alert-card .chip')).toHaveCount(3);
  await page.getByLabel('合约地址', { exact: true }).fill('asset-a');
  await page.getByLabel('标签', { exact: true }).selectOption('low_vol_60m');
  await page.getByRole('button', { name: '筛选记录' }).click();
  await expect(page.locator('.alert-card')).toHaveCount(1);
  assert.ok(requests.some((url) => url.searchParams.get('ca') === 'asset-a' && url.searchParams.get('tag') === 'low_vol_60m'));
  await page.getByText('触发时指标快照', { exact: true }).click();
  await expect(page.locator('.alert-card pre')).toContainText('rpsScores');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});

test('空数据和服务错误显示明确状态，重试后恢复', async (t) => {
  const { page, state, errors } = await pageFixture(t);
  state.failPool = true;
  await page.goto(origin);
  await expect(page.getByRole('alert')).toContainText('HTTP 503');
  state.failPool = false; state.empty = true;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('heading', { name: '暂无匹配资产' })).toBeVisible();
  assert.deepEqual(errors, []);
});

test('RPS保守下界和待补范围有清晰标识，不展示为完整排名', async (t) => {
  const { page, errors, state } = await pageFixture(t);
  state.bounded = true;
  await page.goto(origin);
  await expect(page.getByRole('img', { name: 'R16 86.0–96.0，下界确定达标' }).first()).toBeVisible();
  await expect(page.getByRole('img', { name: 'R96 80.0–90.0，待补数据' }).first()).toBeVisible();
  await expect(page.locator('.rps-bound-label').first()).toHaveText('≥86.0');
  await expect(page.locator('.rps-bound-label').filter({ hasText: '80.0–90.0' }).first()).toBeVisible();
  await expect(page.getByText(/完整排名：暂无/)).toBeVisible();
  assert.deepEqual(errors, []);
});

test('刷新中保留上一轮数值与数值区间，显示进度和原覆盖，不沿用旧标签且移动端无溢出', async (t) => {
  const { page, errors, state } = await pageFixture(t, true);
  state.cached = true;
  state.bounded = true;
  await page.goto(origin);
  await expect(page.locator('.pool-table .chip')).toHaveCount(3);
  state.running = true;
  await page.reload();
  await expect(page.locator('.collection-notice')).toContainText('已处理 2 / 2 个标的 · 成功 1 · 失败 1');
  await expect(page.locator('.collection-notice')).toContainText('固定端点已到位 1 / 2');
  await expect(page.getByRole('progressbar', { name: '本轮行情采集进度' })).toHaveAttribute('value', '2');
  await expect(page.locator('.rps-stamp-previous').first()).toHaveText('上一轮 · 11:30');
  await expect(page.locator('.rps-stamp-previous').first()).toHaveAttribute('title', /原观察池 132 个 CA/);
  await expect(page.getByRole('img', { name: 'R56 76.0（完整排名），上一轮数据，仅供参考' }).first()).toBeVisible();
  await expect(page.locator('.rps-bound-label').filter({ hasText: '80.0–90.0' }).first()).toBeVisible();
  await expect(page.locator('.rps-summary')).toContainText('原观察池 132 个 CA');
  await expect(page.locator('.rps-summary time').first()).toHaveAttribute('datetime', '2026-09-11T11:30:00.000Z');
  await expect(page.locator('.rps-summary time').nth(1)).toHaveAttribute('datetime', '2026-09-11T11:40:00.000Z');
  await expect(page.locator('.coverage-card')).toHaveCount(5);
  await expect(page.getByRole('article', { name: 'R16 覆盖' }).locator('dd')).toHaveText(['126 / 132', '3', '1', '2', '9', '8']);
  await expect(page.locator('.rps-coverage')).toContainText('最近已完成计算的覆盖');
  await expect(page.locator('.pool-table .chip')).toHaveCount(0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.WEB_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.WEB_SCREENSHOT_DIR, 'alpha-refresh-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
});

test('首轮无历史评分时明确等待计算，观察池读取与行情处理进度分开显示', async (t) => {
  const { page, errors, state } = await pageFixture(t, true);
  state.running = true;
  state.firstRound = true;
  state.boardComplete = false;
  state.processed = 0;
  state.succeeded = 0;
  state.failed = 0;
  state.fresh = 0;
  await page.goto(origin);
  await expect(page.locator('.collection-notice')).toContainText('正在读取观察池，完成后开始采集行情');
  await expect(page.locator('.collection-notice')).toContainText('尚无已完成的评分，等待本轮计算');
  await expect(page.locator('.rps-stamp')).toHaveText(['等待本轮计算', '等待本轮计算']);
  await expect(page.locator('.coverage-card')).toHaveCount(0);
  await expect(page.locator('.rps-waiting')).toContainText('暂无已完成的覆盖统计');
  await expect(page.getByRole('progressbar', { name: '本轮行情采集进度' })).toHaveCount(0);
  state.boardComplete = true;
  state.processed = 1;
  state.succeeded = 1;
  state.fresh = 1;
  await page.reload();
  await expect(page.locator('.collection-notice')).toContainText('已处理 1 / 2 个标的 · 成功 1 · 失败 0');
  await expect(page.locator('.collection-notice')).toContainText('固定端点已到位 1 / 2');
  await expect(page.getByRole('progressbar', { name: '本轮行情采集进度' })).toHaveAttribute('value', '1');
  await expect(page.locator('.pool-table .chip')).toHaveCount(0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});

test('已过期评分保留数值但行内及全局明确标记过期，不显示本轮达标标签', async (t) => {
  const { page, errors, state } = await pageFixture(t);
  state.cached = true;
  state.stale = true;
  await page.goto(origin);
  await expect(page.locator('.rps-stamp-stale').first()).toHaveText('已过期 · 11:30');
  await expect(page.locator('.rps-stamp-stale').first()).toHaveAttribute('title', /仅供参考，不参与本轮判定/);
  await expect(page.getByRole('img', { name: 'R16 92.0（完整排名），已过期数据，仅供参考' }).first()).toBeVisible();
  await expect(page.locator('.rps-state-stale')).toHaveText('已过期评分');
  await expect(page.locator('.rps-summary')).toContainText('评分已过期，仅供参考，不参与本轮规则或新标签');
  await expect(page.locator('.quality-notice')).toContainText('显示的历史评分已过期');
  await expect(page.locator('.pool-table .chip')).toHaveCount(0);
  await expect(page.locator('.coverage-card')).toHaveCount(5);
  assert.deepEqual(errors, []);
});

async function sendSnapshot(page, payload, socketIndex = -1) {
  await page.evaluate(({ payload, socketIndex }) => {
    const socket = socketIndex < 0 ? window.__liveSockets.at(-1) : window.__liveSockets[socketIndex];
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }, { payload, socketIndex });
}

const connectionCount = (page) => page.evaluate(() => window.__liveSockets.length);

test('单个共享 WebSocket 直接推送进度和 RPS，无需额外 HTTP 且更新不闪空白', async (t) => {
  const { page, errors, requests, state, snapshot } = await pageFixture(t);
  state.cached = true;
  state.running = true;
  state.processed = 0;
  state.succeeded = 0;
  state.failed = 0;
  state.fresh = 0;
  await page.goto(origin);
  await expect(page.locator('.collection-notice')).toContainText('已处理 0 / 2');
  await expect(page.locator('.rps-stamp-previous').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  assert.equal(await connectionCount(page), 1, 'stats/pool 及 StrictMode 订阅共用一个连接');
  assert.equal(await page.evaluate(() => window.__liveSockets[0].url), origin.replace('http:', 'ws:') + '/api/live');
  const httpBefore = requests.length;

  const progress = snapshot('progress-1');
  progress.stats.dataQuality.collection.processed = 1;
  progress.stats.dataQuality.collection.succeeded = 1;
  progress.stats.dataQuality.freshPriceCount = 1;
  await sendSnapshot(page, progress);
  await expect(page.locator('.collection-notice')).toContainText('已处理 1 / 2');
  await expect(page.locator('.collection-notice')).toContainText('固定端点已到位 1 / 2');
  await expect(page.locator('.rps-value').filter({ hasText: /^92\.0$/ }).first()).toBeVisible();
  await expect(page.locator('.loading')).toHaveCount(0);

  const completed = structuredClone(progress);
  completed.revision = 'completed-2';
  completed.stats.dataQuality.roundRunning = false;
  completed.stats.dataQuality.roundStatus = 'complete';
  completed.stats.dataQuality.rpsAvailable = true;
  completed.stats.dataQuality.rpsFromPreviousRound = false;
  completed.stats.dataQuality.rpsReadyKeys = rpsKeys;
  completed.stats.dataQuality.rpsDisplay.state = 'current';
  completed.stats.dataQuality.rpsDisplay.asOf = now;
  completed.stats.dataQuality.rpsDisplay.computedAt = now + 60_000;
  for (const row of completed.pool.items) {
    row.rpsScores = { ...row.displayRps.scores, r16: 97 };
    row.displayRps = { ...row.displayRps, state: 'current', scores: row.rpsScores, asOf: now, computedAt: now + 60_000 };
    row.tags = [];
  }
  await sendSnapshot(page, completed);
  await expect(page.locator('.rps-value').filter({ hasText: /^97\.0$/ }).first()).toBeVisible();
  await expect(page.locator('.rps-stamp-current').first()).toHaveText('本轮 · 12:00');
  await expect(page.locator('.collection-notice')).toHaveCount(0);
  await expect(page.locator('.loading')).toHaveCount(0);
  await expect(page.locator('.pool-table .chip')).toHaveCount(0);
  assert.equal(requests.length, httpBefore, '收到完整推送后不得通过 HTTP 重新获取数据');
  assert.equal(await connectionCount(page), 1);
  assert.deepEqual(errors, []);
});

test('WebSocket 断线保留评分，重连接受完整快照，旧连接消息不会恢复旧标签', async (t) => {
  const { page, errors, requests, state, snapshot } = await pageFixture(t);
  state.cached = true;
  state.running = true;
  await page.goto(origin);
  await expect(page.locator('.rps-stamp-previous').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  const first = snapshot('server-revision');
  await sendSnapshot(page, first);
  const httpBefore = requests.length;
  await page.evaluate(() => window.__liveSockets[0].close());
  await expect(page.locator('.rps-value').filter({ hasText: /^92\.0$/ }).first()).toBeVisible();
  await expect(page.locator('.loading')).toHaveCount(0);
  await expect.poll(() => connectionCount(page)).toBe(2);

  const fresh = structuredClone(first);
  fresh.stats.dataQuality.collection.processed = 2;
  fresh.stats.dataQuality.collection.succeeded = 2;
  fresh.stats.dataQuality.collection.failed = 0;
  fresh.stats.dataQuality.freshPriceCount = 2;
  for (const row of fresh.pool.items) row.displayRps.scores.r16 = 95;
  // 重连后的第一份完整快照即便 revision 字符串相同也必须接受。
  await sendSnapshot(page, fresh);
  await expect(page.locator('.rps-value').filter({ hasText: /^95\.0$/ }).first()).toBeVisible();
  await expect(page.locator('.collection-notice')).toContainText('成功 2 · 失败 0');
  await expect(page.locator('.collection-notice')).toContainText('固定端点已到位 2 / 2');
  const obsolete = structuredClone(first);
  obsolete.revision = 'late-from-old-connection';
  obsolete.pool.items[0].tags = tags;
  await sendSnapshot(page, obsolete, 0);
  await expect(page.locator('.pool-table .chip')).toHaveCount(0);
  await expect(page.locator('.rps-value').filter({ hasText: /^95\.0$/ }).first()).toBeVisible();
  assert.equal(requests.length, httpBefore, '重连完整快照直接更新页面，无需额外 HTTP');
  assert.equal(await page.evaluate(() => window.__liveSockets.filter((socket) => socket.readyState === WebSocket.OPEN).length), 1);
  assert.deepEqual(errors, []);
});

test('手动 HTTP 刷新保留旧内容，较早响应不能覆盖较新推送或复活旧标签', async (t) => {
  const { page, errors, state, snapshot, heldPoolResponses } = await pageFixture(t);
  state.cached = true;
  await page.goto(origin);
  await expect(page.locator('.pool-table .chip')).toHaveCount(3);
  await page.waitForLoadState('networkidle');
  await sendSnapshot(page, snapshot('initial'));
  state.holdPool = true;
  await page.getByRole('button', { name: '刷新数据', exact: false }).click();
  await expect.poll(() => heldPoolResponses.length).toBe(1);
  await expect(page.getByRole('link', { name: 'ALPHA', exact: true })).toBeVisible();
  await expect(page.locator('.loading')).toHaveCount(0);
  assert.equal(await connectionCount(page), 1, '手动刷新不能重建共享连接');

  const latest = snapshot('newer-push');
  latest.stats.dataQuality.roundRunning = true;
  latest.stats.dataQuality.roundStatus = 'running';
  latest.stats.dataQuality.rpsAvailable = false;
  latest.stats.dataQuality.rpsDisplay.state = 'previous';
  for (const row of latest.pool.items) {
    row.tags = [];
    row.rpsScores = noScores;
    row.displayRps.state = 'previous';
    row.displayRps.scores.r16 = 96;
  }
  await sendSnapshot(page, latest);
  await expect(page.locator('.rps-value').filter({ hasText: /^96\.0$/ }).first()).toBeVisible();
  await expect(page.locator('.pool-table .chip')).toHaveCount(0);
  const finished = page.waitForEvent('requestfinished', (request) => new URL(request.url()).pathname === '/api/pool');
  state.holdPool = false;
  heldPoolResponses.shift()();
  await finished;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('.pool-table .chip')).toHaveCount(0);
  await expect(page.locator('.rps-value').filter({ hasText: /^96\.0$/ }).first()).toBeVisible();
  await expect(page.locator('.collection-notice')).toBeVisible();
  assert.deepEqual(errors, []);
});


const unscoredPoolItem = (ca, symbol, chain = 'robinhood') => ({
  ...poolItem(ca, symbol, chain, 100_000),
  rpsScores: { ...noScores }, rpsBounds: undefined, displayRps: null, tags: [],
  reasons: { a1: false, a2: false, a3: false, a4: false }, lastAlertAt: null,
});

test('最新观察名单通过 WebSocket 增员立即显示，新成员等待计算且不借用旧评分或标签', async (t) => {
  const { page, errors, requests, state, snapshot } = await pageFixture(t);
  state.cached = true;
  state.running = true;
  await page.goto(origin);
  await expect(page.locator('.stats-grid .stat-tile').first().locator('strong')).toHaveText('2');
  await expect(page.locator('.pool-table tbody tr')).toHaveCount(2);
  await expect(page.locator('.rps-stamp-previous').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  const httpBefore = requests.length;

  const latest = snapshot('observation-added-1');
  const updatedAt = now + 300_000;
  latest.stats.poolSize = 3;
  latest.stats.dataQuality.monitored = 3;
  latest.stats.dataQuality.observation = {
    sourceCount: 3, memberCount: 3, updatedAt, refreshMinutes: 5,
    upstreamLimited: false, addedCount: 1, removedCount: 0,
  };
  latest.stats.dataQuality.calculation = {
    memberCount: 132, asOf: now - 1_800_000, computedAt: now - 1_200_000,
  };
  Object.assign(latest.stats.dataQuality.collection, { memberCount: 2, effectiveRpm: 8, minSweepMinutes: 0.25 });
  latest.pool.items.push(unscoredPoolItem('asset-new', 'NOVA'));
  latest.pool.total = 3;
  latest.pool.updatedAt = updatedAt;
  await sendSnapshot(page, latest);

  await expect(page.locator('.stats-grid .stat-tile').first().locator('strong')).toHaveText('3');
  await expect(page.locator('.pool-table tbody tr')).toHaveCount(3);
  await expect(page.locator('.observation-summary')).toContainText('来源去重 3 个 · 已纳入 3 个');
  await expect(page.locator('.observation-summary')).toContainText('最近新增 1 · 移出 0');
  await expect(page.locator('.calculation-summary')).toContainText('当前计算池 132 个 CA');
  const added = page.locator('.pool-table tbody tr').filter({ has: page.getByRole('link', { name: 'NOVA', exact: true }) });
  await expect(added).toBeVisible();
  await expect(added.locator('.rps-value')).toHaveText(['—', '—', '—', '—', '—']);
  await expect(added.locator('.rps-stamp')).toHaveText('等待本轮计算');
  await expect(added.locator('.rps-cell')).toHaveAttribute('data-rps-state', 'waiting');
  await expect(added.locator('.chip')).toHaveCount(0);
  await expect(added).toContainText('等待信号');
  await expect(page.locator('.rps-stamp-previous').first()).toBeVisible();
  await expect(page.locator('.rps-summary')).toContainText('原观察池 132 个 CA');
  await expect(page.locator('.loading')).toHaveCount(0);
  assert.equal(requests.length, httpBefore, '新增名单直接来自完整 WS 快照，不依赖额外 HTTP 或等待采集扫圈');
  assert.equal(await connectionCount(page), 1);
  assert.deepEqual(errors, []);
});

test('移动端区分最新名单494与采集和计算132，展示五分钟名单更新、上游截断及8次每分钟扫描下限', async (t) => {
  const { page, errors, requests, state, snapshot } = await pageFixture(t, true);
  state.cached = true;
  state.running = true;
  await page.goto(origin);
  await expect(page.locator('.pool-table tbody tr')).toHaveCount(2);
  await page.waitForLoadState('networkidle');
  const httpBefore = requests.length;

  const latest = snapshot('observation-full-494');
  const updatedAt = now + 300_000;
  latest.stats.poolSize = 494;
  latest.stats.lastRunAt = updatedAt;
  Object.assign(latest.stats.dataQuality, {
    monitored: 494, freshPriceCount: 23, mayBeTruncated: true,
    observation: { sourceCount: 494, memberCount: 494, updatedAt, refreshMinutes: 5,
      upstreamLimited: true, addedCount: 362, removedCount: 0 },
    calculation: { memberCount: 132, asOf: now - 1_800_000, computedAt: now - 1_200_000 },
    collection: { boardComplete: true, baselineAt: now, processed: 67, succeeded: 60, failed: 7,
      historyAvailable: 100, memberCount: 132, effectiveRpm: 8, minSweepMinutes: 16.5 },
  });
  latest.pool.items.push(...Array.from({ length: 492 }, (_, i) => unscoredPoolItem('fresh-' + i, 'NEW' + i)));
  latest.pool.total = 494;
  latest.pool.updatedAt = updatedAt;
  await sendSnapshot(page, latest);

  await expect(page.locator('.stats-grid .stat-tile').first().locator('strong')).toHaveText('494');
  await expect(page.locator('.pool-table tbody tr')).toHaveCount(494);
  await expect(page.locator('.observation-summary')).toContainText('最新观察名单');
  await expect(page.locator('.observation-summary')).toContainText('来源去重 494 个 · 已纳入 494 个');
  await expect(page.locator('.observation-summary')).toContainText('每 5 分钟发现一次');
  await expect(page.locator('.observation-summary time')).toHaveAttribute('datetime', '2026-09-11T12:05:00.000Z');
  await expect(page.locator('.observation-summary')).toContainText('最近新增 362 · 移出 0');
  await expect(page.locator('.observation-summary')).toContainText('8 次/分钟');
  await expect(page.locator('.observation-summary')).toContainText('至少 61.75 分钟');
  await expect(page.locator('.observation-limited')).toContainText('上游每群最多返回 200 个');
  await expect(page.locator('.observation-limited')).toContainText('名单可能仍有截断');
  await expect(page.locator('.calculation-summary')).toContainText('当前计算池 132 个 CA');
  await expect(page.locator('.collection-notice')).toContainText('本采集轮 132 个标的');
  await expect(page.locator('.collection-notice')).toContainText('已处理 67 / 132 个标的 · 成功 60 · 失败 7');
  await expect(page.locator('.collection-notice')).toContainText('固定端点已到位 23 / 132');
  await expect(page.locator('.collection-notice')).toContainText(/16\.5\s*分钟/);
  await expect(page.getByRole('progressbar', { name: '本轮行情采集进度' })).toHaveAttribute('max', '132');
  await expect(page.getByRole('progressbar', { name: '本轮行情采集进度' })).toHaveAttribute('value', '67');
  await expect(page.locator('.rps-summary')).toContainText('原观察池 132 个 CA');
  await expect(page.getByRole('article', { name: 'R16 覆盖' }).locator('dd')).toHaveText(['126 / 132', '3', '1', '2', '9', '8']);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(requests.length, httpBefore, '全池与速率信息由 WS 完整快照直接更新');
  if (process.env.WEB_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.WEB_SCREENSHOT_DIR, 'alpha-observation-pool-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
});


test('GMGN 正式评分与双来源进度经 WS 更新，冷却说明明确且 390px 不溢出', async (t) => {
  const { page, errors, requests, state, snapshot } = await pageFixture(t, true);
  state.cached = true; state.running = true;
  await page.goto(origin);
  await expect(page.locator('.pool-table tbody tr')).toHaveCount(2);
  await page.waitForLoadState('networkidle');
  const httpBefore = requests.length;
  const payload = snapshot('gmgn-scoring-first');
  payload.stats.dataQuality.enabledSources = ['geckoterminal', 'gmgn'];
  payload.stats.dataQuality.calculation = { memberCount: 2, asOf: now, computedAt: now + 1000,
    sources: { gmgn: 1, geckoterminal: 1, unbound: 0 } };
  payload.stats.dataQuality.gmgn = { enabled: true, status: 'running', updatedAt: now, effectiveRpm: 30,
    requests: 28, recentRequests: 8, historyRequests: 20, assetsWithHistory: 3, backfillPending: 12, cooldownUntil: 0 };
  const pending = structuredClone(payload); pending.revision = 'gmgn-await-current';
  pending.stats.dataQuality.calculation.sources = { gmgn: 0, geckoterminal: 1, unbound: 1 };
  pending.pool.items[0].scoreSource = null; pending.pool.items[0].calculationPending = true;
  pending.pool.items[0].displayRps.source = 'geckoterminal';
  await sendSnapshot(page, pending);
  const awaiting = page.locator('.pool-table tbody tr').filter({ hasText: 'ALPHA' });
  await expect(awaiting.locator('.rps-source')).toHaveText('GeckoTerminal · 固定池');
  await expect(awaiting.locator('.rps-stamp')).toContainText('上一轮');
  await expect(awaiting.locator('.rps-value').first()).toHaveText('92.0');
  await expect(awaiting.locator('.chip')).toHaveCount(0);
  payload.pool.items[0] = { ...payload.pool.items[0], scoreSource: 'gmgn', calculationPending: false,
    rpsScores: { ...noScores, r16: 73 }, tags: [],
    displayRps: { state: 'current', asOf: now, computedAt: now + 1000, poolSize: 2, scores: { ...noScores, r16: 73 } } };
  payload.pool.items[1].scoreSource = 'geckoterminal';
  await sendSnapshot(page, payload);
  const row = page.locator('.pool-table tbody tr').filter({ hasText: 'ALPHA' });
  await expect(row.locator('.rps-source')).toHaveText('GMGN · 代币');
  await expect(row.locator('.rps-value').first()).toHaveText('73.0');
  await expect(row.locator('.chip')).toHaveCount(0);
  await expect(row.locator('.rps-stamp')).toContainText('本轮');
  await expect(page.locator('.scoring-sources')).toContainText('GMGN 1 个 · GeckoTerminal 1 个 · 未绑定 0 个');
  await expect(page.locator('.gmgn-status')).toContainText('限速上限 30 次/分钟');
  await expect(page.locator('.gmgn-backfill')).toContainText('历史范围已查询 3 个 · 队列内待回补 12 个');
  await expect(page.locator('.gmgn-status')).toContainText('历史范围已查询不代表连续 K 线完整');
  await expect(page.locator('.collection-notice strong')).toContainText('GeckoTerminal');
  await expect(page.locator('footer')).toContainText('GeckoTerminal / GMGN');
  const cooldown = structuredClone(payload); cooldown.revision = 'gmgn-cooldown';
  cooldown.stats.dataQuality.gmgn.status = 'cooldown'; cooldown.stats.dataQuality.gmgn.cooldownUntil = now + 60_000;
  await sendSnapshot(page, cooldown);
  await expect(page.locator('.gmgn-status')).toContainText('限流冷却');
  await expect(page.locator('.gmgn-status')).toContainText('最早恢复时间');
  await expect(row.locator('.rps-value').first()).toHaveText('73.0');
  assert.equal(requests.length, httpBefore, 'GMGN 状态与评分直接来自推送，不触发额外 HTTP');
  assert.equal(await page.evaluate(() => window.__liveSockets.length), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});

test('GMGN 详情明确代币 K 线且不生成固定池链接', async (t) => {
  const { page, state, errors } = await pageFixture(t, true);
  state.detailGmgn = true;
  await page.goto(`${origin}/ca/asset-a`);
  const info = page.locator('.asset-info').filter({ has: page.getByRole('heading', { name: '资产信息', exact: true }) });
  await expect(info).toContainText('GMGN · USD · 代币 K 线');
  await expect(info).not.toContainText('固定交易对');
  await expect(page.getByRole('link', { name: '采集交易对 ↗', exact: true })).toHaveCount(0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});


test('主轮与迟到补算文案使用后端配置，WS更新后同步显示', async (t) => {
  const { page, state, snapshot, requests } = await pageFixture(t);
  state.cached = true; state.running = true;
  await page.goto(origin); await expect(page.locator('.pool-table tbody tr')).toHaveCount(2);
  await page.waitForLoadState('networkidle'); const before = requests.length;
  const update = snapshot('hourly-cadence');
  update.stats.refreshMinutes = 60; update.stats.revisionMinutes = 3;
  update.pool.items[0].rpsScores = { ...noScores, r16: 87 };
  update.pool.items[0].displayRps = { state: 'current', asOf: now, computedAt: now + 1000,
    poolSize: 2, scores: { ...noScores, r16: 87 } };
  update.pool.items[0].tags = [];
  await sendSnapshot(page, update);
  await expect(page.locator('.collection-notice')).toContainText('RPS 每 60 分钟建立新一轮');
  await expect(page.locator('.collection-notice')).toContainText('同一时点每 3 分钟最多补算一次');
  await expect(page.locator('.coverage-note')).toContainText('每 60 分钟按固定时点计算');
  await expect(page.locator('.coverage-note')).toContainText('最多每 3 分钟补算一次');
  const row = page.locator('.pool-table tbody tr').filter({ hasText: 'ALPHA' });
  await expect(row.locator('.rps-value').first()).toHaveText('87.0');
  await expect(row.locator('.rps-stamp')).toContainText('本轮');
  await expect(row.locator('.chip')).toHaveCount(0);
  assert.equal(requests.length, before);
});

test('英文浏览器渲染英文界面，可手动切回中文并跨刷新保持', async (t) => {
  const { page, errors } = await pageFixture(t, false, 'en-US');
  await page.goto(origin);
  // 默认跟随浏览器语言：非中文环境一律英文
  await expect(page.getByRole('heading', { name: 'Watchlist', level: 1 })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('link', { name: 'Alert history' })).toBeVisible();
  await expect(page.getByPlaceholder('Search symbol or CA…')).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /Market cap/ })).toBeVisible();
  // 标签文案也走英文
  await expect(page.locator('.chip').first()).toContainText('all-time-high pullback');
  // 只校验界面文案已英文化；表格单元格里的群名是夹具数据，本来就是中文，不在此列。
  // .filters 里的群组下拉选项是夹具数据（中文群名），标签单独断言。
  const chrome = await page.locator('.page-heading, .stats-grid, .panel-heading, thead, .footnote').allInnerTexts();
  const leftover = chrome.filter((text) => /[\u4e00-\u9fff]/.test(text));
  assert.deepEqual(leftover, [], '界面文案不应残留中文');
  await expect(page.locator('footer')).toContainText('Chat data');
  for (const label of ['Chain', 'Group', 'Signal']) await expect(page.locator('.filters')).toContainText(label);
  await expect(page.locator('.filters')).toContainText('All chains');

  await page.getByRole('button', { name: /Switch language/ }).click();
  await expect(page.getByRole('heading', { name: '观察池', level: 1 })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  // 手动选择优先于浏览器语言，刷新后保持
  await page.reload();
  await expect(page.getByRole('heading', { name: '观察池', level: 1 })).toBeVisible();
  assert.deepEqual(errors, []);
});

test('中文浏览器默认中文，且英文切换后详情与告警页同样生效', async (t) => {
  const { page, errors } = await pageFixture(t);
  await page.goto(origin);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await page.getByRole('button', { name: /Switch language/ }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.goto(`${origin}/alerts`);
  await expect(page.getByRole('heading', { name: 'Alert history', level: 1 })).toBeVisible();
  await expect(page.getByText('Triggers')).toBeVisible();
  await page.goto(`${origin}/ca/asset-a`);
  await expect(page.getByText('Asset info')).toBeVisible();
  await expect(page.getByText('Market source')).toBeVisible();
  assert.deepEqual(errors, []);
});
