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

async function pageFixture(t, mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1050 }, colorScheme: 'light' });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  const state = { failPool: false, empty: false };
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()); requests.push(url);
    let body;
    if (url.pathname === '/api/stats') body = { poolSize: 2, alertsToday: 1, quota: { used: 420, limit: 10_500 },
      lastRunAt: now, refreshMinutes: 30, quotaWarningPercent: 85,
      dataQuality: { mayBeTruncated: false, freshPriceCount: 2, rpsAvailable: true } };
    else if (url.pathname === '/api/pool') {
      if (state.failPool) return route.fulfill({ status: 503, json: { error: 'UNAVAILABLE' } });
      body = { items: state.empty ? [] : items, total: state.empty ? 0 : 2, updatedAt: now };
    } else if (url.pathname === '/api/alerts') body = { items: [alert], total: 1 };
    else if (url.pathname === '/api/ca/asset-a') {
      const ms = { '30m': 1_800_000, '60m': 3_600_000, '4h': 14_400_000 }[url.searchParams.get('interval')];
      const candles = Array.from({ length: 70 }, (_, i) => ({ openTime: now - (70 - i) * ms,
        open: 10 + i / 10, close: 10 + i / 10 + (i % 2 ? -.1 : .2), high: 10.5 + i / 10, low: 9.5 + i / 10, volume: 1000 + i * 10 }));
      body = { pool: items[0], candles, indicators: { rsi: candles.slice(14).map((bar, i) => ({ openTime: bar.openTime, value: 45 + Math.sin(i / 4) * 15 })),
        volumeMa: candles.slice(38).map((bar) => ({ openTime: bar.openTime, value: 1300 })),
        parameters: { rsiPeriod: 14, volMaPeriod: 39, rsiBelow: 50, maxRsi: 60 } },
        moments: [{ moment: 1, barTime: candles[50].openTime, price: candles[50].high }], alerts: [alert] };
    } else return route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } });
    return route.fulfill({ status: 200, json: body });
  });
  return { page, errors, requests, state };
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
