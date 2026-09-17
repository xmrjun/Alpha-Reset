import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SocialPost } from '../../src/indicators/social-quality.js';
import { AgentToolError } from '../../src/web/agent-tools.js';
import { SocialLookup } from '../../src/web/social-lookup.js';

const CA = '7vSG4GX8qz5V36noSde5Z9xV8xAXAGqivDyaNytPVDJf';
const t0 = Date.parse('2026-09-17T08:00:00Z');

function samplePost(id: string): SocialPost {
  return {
    id, text: 'talking about $Foo', urls: [], views: 900, likes: 5, retweets: 1, createdAt: t0,
    author: { screenName: 'a', followers: 900, friends: 500, statuses: 3000,
      description: '', createdAt: t0 - 1000 * 86_400_000, verified: false },
  };
}

function fakeClient() {
  let calls = 0;
  return {
    get calls() { return calls; },
    async searchMentions() {
      calls += 1;
      return { posts: [samplePost('p1')], costUsd: 0.0001, skipped: 0 };
    },
  };
}

function lookup(client: ReturnType<typeof fakeClient> | null, now: () => number, over = {}) {
  return new SocialLookup({ client, clock: now, dailyLimit: 3, perClientLimit: 2, cacheMs: 600_000, ...over });
}

test('同一个合约十分钟内只打一次上游，重复提问走缓存', async () => {
  const client = fakeClient();
  let now = t0;
  const svc = lookup(client, () => now);

  const first = await svc.check(CA, 'visitor-1');
  now += 60_000;
  const second = await svc.check(CA, 'visitor-1');

  assert.equal(client.calls, 1, '缓存期内不该重复花钱');
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.quality.total, 1);
});

test('缓存过期后重新查', async () => {
  const client = fakeClient();
  let now = t0;
  const svc = lookup(client, () => now);
  await svc.check(CA, 'visitor-1');
  now += 600_001;
  await svc.check(CA, 'visitor-1');
  assert.equal(client.calls, 2);
});

test('全局日配额用尽后直接拒绝，一分钱都不再花', async () => {
  const client = fakeClient();
  let now = t0;
  const svc = lookup(client, () => now, { perClientLimit: 99 });

  for (let i = 0; i < 3; i += 1) await svc.check(`ca-${i}`, 'visitor-1');
  assert.equal(client.calls, 3);

  await assert.rejects(() => svc.check('ca-x', 'visitor-1'), (error: AgentToolError) => {
    assert.equal(error.code, 'BUDGET_EXHAUSTED');
    return true;
  });
  assert.equal(client.calls, 3, '拒绝之后不得再打上游');
});

test('单个访客有自己的上限，一个人刷不完全局额度', async () => {
  const client = fakeClient();
  const svc = lookup(client, () => t0);
  await svc.check('ca-1', 'noisy');
  await svc.check('ca-2', 'noisy');
  await assert.rejects(() => svc.check('ca-3', 'noisy'), (error: AgentToolError) => {
    assert.equal(error.code, 'BUDGET_EXHAUSTED');
    return true;
  });
  // 换个人还能用，全局额度还剩一次
  const other = await svc.check('ca-3', 'someone-else');
  assert.equal(other.cached, false);
});

test('缓存命中不计入配额：重复问同一个币不该被扣次数', async () => {
  const client = fakeClient();
  const svc = lookup(client, () => t0, { perClientLimit: 2 });
  await svc.check(CA, 'visitor-1');
  await svc.check(CA, 'visitor-1');
  await svc.check(CA, 'visitor-1');
  const other = await svc.check('ca-other', 'visitor-1');
  assert.equal(other.cached, false, '前面三次只应扣掉一次额度');
  assert.equal(client.calls, 2);
});

test('跨自然日后配额重置', async () => {
  const client = fakeClient();
  let now = t0;
  const svc = lookup(client, () => now, { perClientLimit: 99 });
  for (let i = 0; i < 3; i += 1) await svc.check(`ca-${i}`, 'v');
  await assert.rejects(() => svc.check('ca-x', 'v'));

  now = Date.parse('2026-09-18T00:00:01Z');
  const fresh = await svc.check('ca-x', 'v');
  assert.equal(fresh.cached, false);
  assert.equal(client.calls, 4);
});

test('未配置凭据时给明确错误，而不是静默返回空结果', async () => {
  const svc = lookup(null, () => t0);
  await assert.rejects(() => svc.check(CA, 'v'), (error: AgentToolError) => {
    assert.equal(error.code, 'NOT_CONFIGURED');
    return true;
  });
});

test('返回里带今日用量，前端能显示还剩多少次', async () => {
  const svc = lookup(fakeClient(), () => t0);
  const result = await svc.check(CA, 'v');
  assert.equal(result.usedToday, 1);
  assert.equal(result.dailyLimit, 3);
  assert.ok(result.costUsd > 0);
});
