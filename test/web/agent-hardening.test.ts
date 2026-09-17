import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SocialPost } from '../../src/indicators/social-quality.js';
import { AgentToolError, parseToolArgs } from '../../src/web/agent-tools.js';
import { clientKey } from '../../src/web/server.js';
import { SocialLookup } from '../../src/web/social-lookup.js';

const t0 = Date.parse('2026-09-17T08:00:00Z');
const EVM = '0x648a5382bdcf286e7ff5122d01a983db314e620a';
const SOL = '7vSG4GX8qz5V36noSde5Z9xV8xAXAGqivDyaNytPVDJf';

test('social_check 只接受合约地址，不接受任意搜索词', () => {
  // 这个参数会被原样送进 X 的搜索接口，而每次搜索都花运营方的钱。
  // 放任意字符串进来 = 把站点变成别人免费用的匿名搜索服务。
  assert.equal(parseToolArgs('social_check', { ca: EVM }).ca, EVM);
  assert.equal(parseToolArgs('social_check', { ca: SOL }).ca, SOL);
  assert.equal(parseToolArgs('social_check', { ca: '  ' + EVM + ' ' }).ca, EVM, '两侧空白应被裁掉而不是拒绝');

  for (const bad of ['bitcoin elon musk', 'from:elonmusk', '$TRUMP OR $DOGE',
    'aaaaaaaa', '0xnothex0000000000000000000000000000000000', EVM + 'ff']) {
    assert.throws(() => parseToolArgs('social_check', { ca: bad }), AgentToolError,
      `应拒绝非合约地址：${bad}`);
  }
});

function fakeClient(delayMs = 0) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async searchMentions(): Promise<{ posts: readonly SocialPost[]; costUsd: number; skipped: number }> {
      calls += 1;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return { posts: [], costUsd: 0.0001, skipped: 0 };
    },
  };
}

test('并发请求不能绕过配额：额度在打上游之前就要占住', async () => {
  // 判断在 await 之前、自增在 await 之后的话，N 个并发会全部通过检查。
  const client = fakeClient(20);
  const svc = new SocialLookup({ client, clock: () => t0, dailyLimit: 3, perClientLimit: 99, cacheMs: 0 });

  const results = await Promise.allSettled(
    Array.from({ length: 30 }, (_, i) => svc.check(`0x${String(i).padStart(40, '0')}`, 'v')),
  );
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  assert.ok(client.calls <= 3, `最多只该打 3 次上游，实际 ${client.calls}`);
  assert.ok(ok <= 3, `最多只该有 3 次成功，实际 ${ok}`);
});

test('同一个合约并发提问只打一次上游，其余复用同一次结果', async () => {
  const client = fakeClient(20);
  const svc = new SocialLookup({ client, clock: () => t0, dailyLimit: 100, perClientLimit: 100, cacheMs: 600_000 });
  await Promise.all(Array.from({ length: 20 }, () => svc.check(EVM, 'v')));
  assert.equal(client.calls, 1, `同一合约并发 20 次只该打一次，实际 ${client.calls}`);
});

test('上游失败要把占住的额度退回去，不能让一次故障白吃一次配额', async () => {
  let calls = 0;
  const failing = {
    async searchMentions(): Promise<{ posts: readonly SocialPost[]; costUsd: number; skipped: number }> {
      calls += 1;
      throw new Error('upstream down');
    },
  };
  const svc = new SocialLookup({ client: failing, clock: () => t0, dailyLimit: 2, perClientLimit: 2, cacheMs: 0 });
  await assert.rejects(() => svc.check(EVM, 'v'));
  await assert.rejects(() => svc.check(SOL, 'v'));
  assert.equal(calls, 2, '两次都该真的尝试过，说明失败没有白扣额度');
});

test('访客身份取 nginx 覆盖式写入的 X-Real-IP，不信客户端可伪造的 X-Forwarded-For', () => {
  // nginx: X-Real-IP 用 $remote_addr 覆盖；X-Forwarded-For 是 $proxy_add_x_forwarded_for，
  // 会把客户端自己发的值原样留在第一段。取 XFF 第一段 = 配额随便重置。
  assert.equal(clientKey({ headers: { 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4' } }), '9.9.9.9');
  assert.equal(clientKey({ headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '9.9.9.9' } }), '9.9.9.9',
    '没有 X-Real-IP 时用连接地址，仍然不采信 XFF');
  assert.equal(clientKey({ headers: {} }), 'unknown');
});
