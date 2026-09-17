import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { XapiTwitterClient } from '../../src/api/xapi-twitter.js';

const FAKE_KEY = 'xapi_test_fake';

function reply(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 上游真实形状的最小子集：故意留几个 null / 缺失字段。 */
const SAMPLE = {
  code: 200,
  msg: 'success',
  data: [
    {
      tweet_id: '1',
      text: '🚀 Foo Coin $Foo airdrop CA=abc https://t.co/x',
      full_text: '🚀 Foo Coin $Foo airdrop CA=abc https://t.co/x',
      view_count: '27',        // 真实上游发的是字符串
      favorite_count: 0,
      retweet_count: 2,
      bookmark_count: 0,
      is_paid_promotion: false,
      created_at: 'Thu Sep 17 11:49:52 +0000 2026',
      urls: ['https://foo-drop.netlify.app/?Foo=abc'],
      user: {
        screen_name: 'acct_a',
        followers_count: '1786',   // 同样可能是字符串
        friends_count: null,          // 上游这个字段是空的
        following_count: 4523,        // 真正有值的是这个
        statuses_count: 33695,
        description: 'Solana memecoin is best',
        created_at: 'Sat Jan 18 19:12:58 +0000 2014',
        is_blue_verified: false,
      },
    },
    {
      tweet_id: '2',
      text: 'real talk about $Foo',
      view_count: '900',
      favorite_count: 12,
      // retweet_count / urls / bookmark_count 整个缺失
      created_at: 'Thu Sep 17 10:00:00 +0000 2026',
      user: {
        screen_name: 'acct_b',
        followers_count: 60_000,
        following_count: 800,
        statuses_count: 4000,
        description: 'trader',
        created_at: 'Sat Jan 18 19:12:58 +0000 2020',
        is_verified: true,
      },
    },
  ],
};

test('凭据走请求头，绝不出现在 URL 里', async (t: TestContext) => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    seenUrl = String(url); seenInit = init; return reply(SAMPLE);
  });

  const client = new XapiTwitterClient({ apiKey: FAKE_KEY });
  await client.searchMentions('abc');

  assert.ok(!seenUrl.includes(FAKE_KEY), 'key 不能进 URL：网关和 nginx 都会把 URL 写进访问日志');
  assert.equal(seenInit?.method, 'POST');
  const headers = new Headers(seenInit?.headers);
  assert.equal(headers.get('xapi-key'), FAKE_KEY);
});

test('上游字段映射到判定要用的形状，缺失与 null 都有兜底', async (t: TestContext) => {
  t.mock.method(globalThis, 'fetch', async () => reply(SAMPLE));
  const client = new XapiTwitterClient({ apiKey: FAKE_KEY });
  const { posts } = await client.searchMentions('abc');

  assert.equal(posts.length, 2);
  const [first, second] = posts;

  assert.equal(first?.author.screenName, 'acct_a');
  assert.equal(first?.author.friends, 4523, 'friends_count 是 null 时要回退到 following_count');
  assert.equal(first?.views, 27);
  assert.deepEqual(first?.urls, ['https://foo-drop.netlify.app/?Foo=abc']);
  assert.ok(first && first.createdAt > 0, '上游的英文日期要能解析成时间戳');

  assert.equal(second?.retweets, 0, '缺失的计数按 0 处理，不能是 undefined');
  assert.deepEqual(second?.urls, []);
  assert.equal(second?.author.verified, true, 'is_verified 与 is_blue_verified 任一为真即算认证');
});

test('计数字段是字符串时照样解析，不能整条丢掉', async (t: TestContext) => {
  // 线上实测：view_count 发的是 "30" 这样的字符串，早先按 number 校验导致整批被丢弃。
  t.mock.method(globalThis, 'fetch', async () => reply(SAMPLE));
  const client = new XapiTwitterClient({ apiKey: FAKE_KEY });
  const { posts, skipped } = await client.searchMentions('abc');
  assert.equal(skipped, 0, '字符串计数不该让推文被丢弃');
  assert.equal(posts[0]?.views, 27);
  assert.equal(posts[0]?.author.followers, 1786);
});

test('把这次调用的真实花费带回来，调用方据此算预算', async (t: TestContext) => {
  t.mock.method(globalThis, 'fetch', async () =>
    reply(SAMPLE, { 'x-xapi-cost': '0.00010000', 'x-xapi-cost-unit': 'USD' }));
  const client = new XapiTwitterClient({ apiKey: FAKE_KEY });
  const { costUsd } = await client.searchMentions('abc');
  assert.equal(costUsd, 0.0001);
});

test('上游报错不把原文透出去，只给稳定的错误码', async (t: TestContext) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response('upstream said something with a secret in it', { status: 502 }));
  const client = new XapiTwitterClient({ apiKey: FAKE_KEY });
  await assert.rejects(() => client.searchMentions('abc'), (error: Error) => {
    assert.equal(error.name, 'XapiError');
    assert.ok(!error.message.includes('secret'), '不得回显上游原文');
    return true;
  });
});

test('响应结构不对时拒绝，不把脏数据喂进判定', async (t: TestContext) => {
  t.mock.method(globalThis, 'fetch', async () => reply({ code: 200, msg: 'ok', data: 'not-an-array' }));
  const client = new XapiTwitterClient({ apiKey: FAKE_KEY });
  await assert.rejects(() => client.searchMentions('abc'), /XapiError|结构/);
});

test('单条推文缺了必要字段时跳过它，不让整次查询失败', async (t: TestContext) => {
  t.mock.method(globalThis, 'fetch', async () => reply({
    code: 200, msg: 'success',
    data: [{ tweet_id: '1', text: 'ok', created_at: 'Thu Sep 17 11:49:52 +0000 2026',
      user: { screen_name: 'a', followers_count: 1, following_count: 1, statuses_count: 1,
        description: '', created_at: 'Sat Jan 18 19:12:58 +0000 2014' } },
      { tweet_id: '2' }],
  }));
  const client = new XapiTwitterClient({ apiKey: FAKE_KEY });
  const { posts, skipped } = await client.searchMentions('abc');
  assert.equal(posts.length, 1);
  assert.equal(skipped, 1);
});
