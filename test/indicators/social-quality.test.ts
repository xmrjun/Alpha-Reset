import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KOL_MIN_FOLLOWERS, assessSocial, type SocialPost } from '../../src/indicators/social-quality.js';
import { MANUFACTURED_IDS, TULIP_POSTS } from './tulip-sample.js';

const day = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-17T12:00:00Z');

function post(id: string, text: string, over: Partial<SocialPost> = {}): SocialPost {
  return {
    id, text, urls: [], views: 800, likes: 5, retweets: 2, createdAt: now - day,
    author: { screenName: 'someone', followers: 900, friends: 700, statuses: 3000,
      description: 'just a person', createdAt: now - 1200 * day, verified: false },
    ...over,
  };
}

test('真实样本整体判定为刷量：20 条里只有少数有机', () => {
  const q = assessSocial(TULIP_POSTS);
  assert.equal(q.total, 20);
  assert.equal(q.verdict, 'manufactured', `判定应为 manufactured，实际 ${q.verdict}`);
  assert.ok(q.botRatio >= 0.7, `刷量占比应 ≥0.7，实际 ${q.botRatio}`);
  assert.ok(q.medianViews < 200, `浏览量中位数应很低，实际 ${q.medianViews}`);
});

test('逐条对照人工标注：批量投放的全部抓到，有机内容一条不误伤', () => {
  const q = assessSocial(TULIP_POSTS);
  const flagged = new Set(q.posts.filter((p) => p.manufactured).map((p) => p.id));
  const expected = new Set(MANUFACTURED_IDS);

  const missed = [...expected].filter((id) => !flagged.has(id));
  const wrong = [...flagged].filter((id) => !expected.has(id));
  assert.deepEqual(missed, [], `漏判（人工认为是刷量却没抓到）：${missed.join(',')}`);
  assert.deepEqual(wrong, [], `误伤（有机内容被当成刷量）：${wrong.join(',')}`);
});

test('同一套文案只换 emoji 和落地页域名，仍然归进同一个模板簇', () => {
  const ca = 'So11111111111111111111111111111111111111112';
  const posts = [
    post('a', `🚀 Foo Coin $Foo is gaining attention on Solana $SOL. Check out this crypto airdrop and see what the token is about. CA=${ca}`,
      { urls: ['https://aaa-drop.netlify.app/?Foo=' + ca], views: 40 }),
    post('b', `🌐 Foo Coin $Foo just landed on my Solana $SOL watchlist. Check out the crypto airdrop and learn more about the token. CA=${ca}`,
      { urls: ['https://bbb-giveaway.netlify.app/?Foo=' + ca], views: 55 }),
    post('c', `🪙 Foo Coin $Foo is another token to watch on Solana $SOL. Explore the crypto airdrop and see if the memecoin interests you. CA=${ca}`,
      { urls: ['https://ccc-drops.netlify.app/?Foo=' + ca], views: 61 }),
  ];
  const q = assessSocial(posts);
  assert.equal(q.clusters, 1, '三条应归为一个模板簇');
  assert.equal(q.manufactured, 3);
});

test('僵尸号画像：只关注 9 个人却有两千多粉丝，且每天发几十条', () => {
  const zombie = post('z', '$Foo looks interesting today', {
    author: { screenName: 'z', followers: 2503, friends: 9, statuses: 57391,
      description: 'A ♥ D', createdAt: now - 3000 * day, verified: false },
  });
  const q = assessSocial([zombie]);
  assert.ok(q.posts[0]?.flags.includes('zombie_account'),
    `应标记僵尸号，实际 flags=${q.posts[0]?.flags.join(',')}`);
});

test('正常讨论不会被误判成刷量', () => {
  const posts = [
    post('a', '$Foo 这波拉盘是因为上了新的 launchpad，仓位我加了一点'),
    post('b', 'just aped into $Foo, the chart looks clean and volume is real'),
    post('c', '$Foo 和 $BAR 的联动很明显，两个都在同一个盘手手里'),
  ];
  const q = assessSocial(posts);
  assert.equal(q.manufactured, 0);
  assert.equal(q.verdict, 'organic');
});

test('没有任何提及时返回 quiet，而不是当成刷量', () => {
  const q = assessSocial([]);
  assert.equal(q.verdict, 'quiet');
  assert.equal(q.total, 0);
  assert.equal(q.botRatio, 0);
});

test('真实大V要粉丝达标且本身不是刷量账号', () => {
  const kol = post('k', '$Foo 我买了一些，团队我认识', {
    views: 90_000, likes: 800, retweets: 120,
    author: { screenName: 'big_voice', followers: KOL_MIN_FOLLOWERS + 1, friends: 900,
      statuses: 12_000, description: 'crypto trader', createdAt: now - 2000 * day, verified: true },
  });
  const spam = post('s', '🚀 Foo Coin $Foo is gaining attention on Solana $SOL. Check out this crypto airdrop.', {
    views: 30, urls: ['https://x-drop.netlify.app/?Foo=1'],
    author: { screenName: 'loud_bot', followers: KOL_MIN_FOLLOWERS + 5, friends: 3,
      statuses: 99_000, description: '', createdAt: now - 3000 * day, verified: false },
  });
  const q = assessSocial([kol, spam, spam]);
  assert.deepEqual(q.kols, ['big_voice'], '粉丝多但被判为刷量的账号不算大V');
});

test('文本里 @ 到的账号被收集起来，供调用方再去查证', () => {
  const q = assessSocial([post('a', 'hey @alpha_caller @beta_desk 看看这个 $Foo')]);
  assert.deepEqual(q.mentions, ['alpha_caller', 'beta_desk']);
});
