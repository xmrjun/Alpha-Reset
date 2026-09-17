import type { SocialPost } from '../../src/indicators/social-quality.js';

/**
 * 真实样本：2026-09-17 抓的 Solana 代币 Tulip（CA 7vSG4G…VDJf）的 20 条推文。
 *
 * 这是判定规则的基准案例：人工核对下来只有少数几条是有机内容，其余是同一套文案
 * 换 emoji + 轮换 netlify.app 落地页的批量投放。规则改动后必须仍能把它们分开。
 *
 * 账号名已脱敏成 acct_NN：推文本身是公开的，但本文件随源码公开，不该点名把
 * 可能是被盗号的真人挂上「僵尸号」的标签。粉丝数/关注数/发帖数/注册时间/文案
 * 全部保持原值，判定规则要用的特征一个没动。被 @ 的账号同样换成占位符。
 */

const CA = '7vSG4GX8qz5V36noSde5Z9xV8xAXAGqivDyaNytPVDJf';

interface Compact {
  readonly acct: string;
  readonly fw: number;      // followers
  readonly fr: number;      // friends
  readonly st: number;      // statuses
  readonly born: string;    // 账号注册时间
  readonly desc: string;
  readonly at: string;
  readonly views: number;
  readonly likes: number;
  readonly rts: number;
  readonly text: string;
  readonly urls?: readonly string[];
}

const rows: readonly Compact[] = [
  { acct: 'acct_01', fw: 1786, fr: 4523, st: 33695, born: '2014-01-18', desc: 'Solana memecoin is best',
    at: '2026-09-17T11:49:52Z', views: 27, likes: 0, rts: 0,
    text: `🚀 Tulip Coin $Tulip is gaining attention on Solana $SOL.\n\n Check out this crypto airdrop and see what the token is about.\n\n CA=${CA}\n\n https://t.co/qufBkZ6y0Q`,
    urls: [`https://token-drop.netlify.app/?Tulip=${CA}`] },

  { acct: 'acct_02', fw: 2503, fr: 9, st: 57391, born: '2017-09-13', desc: 'A ♥ D  ➡ AGMZ ❤️',
    at: '2026-09-17T08:28:53Z', views: 67, likes: 0, rts: 4,
    text: `🌐 Tulip Coin $Tulip just landed on my Solana $SOL watchlist.\n\n Check out the crypto airdrop and learn more about the token.\n\n CA=${CA}\n\n https://t.co/WgvIWcwJOh`,
    urls: [`https://memecoins-giveaway.netlify.app/?Tulip=${CA}`] },

  { acct: 'acct_03', fw: 2401, fr: 2312, st: 33303, born: '2020-04-15', desc: 'Trump 2020 🇺🇸 Do Not DM ! Happily Married !!',
    at: '2026-09-17T07:26:23Z', views: 71, likes: 0, rts: 1,
    text: `🚀 New one to check: Tulip Coin $Tulip on Solana $SOL.\n\n Take a look at this crypto airdrop and see what the memecoin offers.\n\n CA=${CA}\n\n https://t.co/1jWhVi9mdY`,
    urls: [`https://memecoins-giveaway.netlify.app/?Tulip=${CA}`] },

  { acct: 'acct_04', fw: 1030, fr: 621, st: 147344, born: '2011-11-20', desc: 'A cosmic NFT collection for curious minds.',
    at: '2026-09-17T06:37:52Z', views: 69, likes: 1, rts: 1,
    text: 'Attention $TULIP Family! YOUR vote matters!\n\nLess than 100 votes are needed to list $TULIP on the Moonshot Top 100 Leaderboard.\n\n- Listing ID: 9320\n\nEvery vote counts - Moonshot would be huge for community growth. ⤵️\nhttps://t.co/gZ3ofsEqMQ',
    urls: [`https://moonshot-listing-fye.netlify.app/vote/${CA}`] },

  { acct: 'acct_05', fw: 419, fr: 583, st: 2869, born: '2014-04-07', desc: "I'm Olivia & I live in the mountains",
    at: '2026-09-17T02:58:48Z', views: 99, likes: 1, rts: 0,
    text: '@kol_one \n\npweez shill, I beg\n\n🥺\n🙏🏼\n\nCheck out $Tulip on fomo:\n\n$Tulip \n\nhttps://t.co/V0ZIQtnt2P',
    urls: [`https://fomo.family/coin?address=${CA}&chainId=1399811149`] },

  { acct: 'acct_06', fw: 1301, fr: 906, st: 38163, born: '2010-01-22', desc: 'Soy Abogada, pero soy mejor compartiendo memes',
    at: '2026-09-16T20:09:17Z', views: 98, likes: 1, rts: 2,
    text: `🪙 Tulip Coin $Tulip is another token to watch on Solana $SOL.\n\n Explore the crypto airdrop and see if the memecoin interests you.\n\n CA=${CA}\n\n https://t.co/Ein8oKVqUi`,
    urls: [`https://meme-drops.netlify.app/?Tulip=${CA}`] },

  { acct: 'acct_07', fw: 102, fr: 190, st: 2601, born: '2011-11-22', desc: '',
    at: '2026-09-16T20:03:19Z', views: 153, likes: 0, rts: 0,
    text: `$Tulip TG is Officially Live💫\nhttps://t.co/BIoLpCt6Hm\n\n${CA}`,
    urls: ['https://t.me/TulipsCoin'] },

  { acct: 'acct_08', fw: 1317, fr: 295, st: 48055, born: '2015-11-01', desc: 'those are my nachos btw',
    at: '2026-09-16T18:42:08Z', views: 94, likes: 0, rts: 1,
    text: `🧐 Looking into Tulip Coin $Tulip on Solana $SOL.\n\n This crypto airdrop is worth a look if you follow memecoins and coins.\n\n CA=${CA}\n\n https://t.co/9eSuSlypQp`,
    urls: [`https://meme-drops.netlify.app/?Tulip=${CA}`] },

  { acct: 'acct_09', fw: 1680, fr: 350, st: 5157, born: '2016-02-04', desc: '✖️Follow me on Instagram',
    at: '2026-09-16T18:40:01Z', views: 80, likes: 0, rts: 1,
    text: `💰 Keeping an eye on Tulip Coin $Tulip on Solana $SOL.\n\n Check this crypto airdrop if you're exploring new tokens and memecoins.\n\n CA=${CA}\n\n https://t.co/uMMQ2fcBso`,
    urls: [`https://meme-drops.netlify.app/?Tulip=${CA}`] },

  { acct: 'acct_10', fw: 545, fr: 867, st: 2290, born: '2014-03-06', desc: 'Sourdough fortress librarians preserve edible histories.',
    at: '2026-09-16T18:20:52Z', views: 67, likes: 1, rts: 1,
    text: 'Attention $TULIP Family! YOUR vote matters!\n\nLess than 100 votes are needed to list $TULIP on the Moonshot Top 100 Leaderboard.\n\n- Listing ID: 2240\n\nEvery vote counts - Moonshot would be huge for community growth. ↓\nhttps://t.co/bSjS2MjryN',
    urls: [`https://moonshot-listing-vgr.netlify.app/vote/${CA}`] },

  { acct: 'acct_06', fw: 1301, fr: 906, st: 38163, born: '2010-01-22', desc: 'Soy Abogada, pero soy mejor compartiendo memes',
    at: '2026-09-16T16:09:44Z', views: 83, likes: 0, rts: 1,
    text: `🪙 Tulip Coin $Tulip is another token to watch on Solana $SOL.\n\n Explore the crypto airdrop and see if the memecoin interests you.\n\n CA=${CA}\n\n https://t.co/RigJvlROfy`,
    urls: [`https://memecoin-giveaway.netlify.app/?Tulip=${CA}`] },

  { acct: 'acct_11', fw: 2093, fr: 3105, st: 32011, born: '2009-07-15', desc: '',
    at: '2026-09-16T13:46:07Z', views: 98, likes: 1, rts: 0,
    text: `⚙️ Checking out Tulip Coin $Tulip on Solana $SOL.\n\n See the crypto airdrop and get a quick look at this token and coin.\n\n CA=${CA}\n\n https://t.co/Jdoas2eu9Q`,
    urls: [`https://memecoin-giveaway.netlify.app/?Tulip=${CA}`] },

  { acct: 'acct_12', fw: 60, fr: 13, st: 210, born: '2023-08-01', desc: '',
    at: '2026-09-16T09:59:48Z', views: 100, likes: 1, rts: 0,
    text: 'DarkNightBMT called $Tulip on https://t.co/hQiV2RHZb5 https://t.co/sAhby3BRTC',
    urls: ['https://pump.fun', `https://pump.fun/callouts/${CA}/39bf07fb`] },

  { acct: 'acct_13', fw: 329, fr: 2341, st: 18306, born: '2024-07-12', desc: 'lightweight, soft hat',
    at: '2026-09-16T09:19:09Z', views: 80, likes: 0, rts: 0,
    text: `$Tulip -  CA: ${CA} \n View full analysis 🔗 https://t.co/MJZui4A3G7 \n \n Check No. 05919383`,
    urls: ['https://rb.gy/rood6i'] },

  { acct: 'acct_14', fw: 146, fr: 1305, st: 1359, born: '2024-01-02', desc: 'DEX Trader | Web3 Advocate | DeFi Researcher',
    at: '2026-09-16T06:18:37Z', views: 187, likes: 3, rts: 0,
    text: `Gm family bought some $TULIP \n${CA}` },

  { acct: 'acct_15', fw: 1434, fr: 1242, st: 15225, born: '2013-11-18', desc: 'Macaron mechanics maintain vessels beneath ocean trenches.',
    at: '2026-09-16T05:20:19Z', views: 93, likes: 1, rts: 1,
    text: 'Attention $TULIP Family! YOUR vote matters!\n\nLess than 100 votes are needed to list $TULIP on the Moonshot Top 100 Leaderboard.\n\n- Listing ID: 4843\n\nEvery vote counts - Moonshot would be huge for community growth. ↙️\nhttps://t.co/nsvY8dUcUW',
    urls: [`https://moonshot-listing-vgr.netlify.app/vote/${CA}`] },

  { acct: 'acct_16', fw: 1480, fr: 175, st: 41931, born: '2023-03-25', desc: '',
    at: '2026-09-16T03:41:34Z', views: 107, likes: 0, rts: 0,
    text: `🚨 Spotted Tulip Coin $Tulip on Solana $SOL.\n\n Check the crypto airdrop and see whether this memecoin catches your eye.\n\n CA=${CA}\n\n https://t.co/inMHJku1wL`,
    urls: [`https://solana-drops.netlify.app/?Tulip=${CA}`] },

  { acct: 'acct_03', fw: 2401, fr: 2312, st: 33303, born: '2020-04-15', desc: 'Trump 2020 🇺🇸 Do Not DM ! Happily Married !!',
    at: '2026-09-16T02:42:33Z', views: 102, likes: 0, rts: 0,
    text: `🚀 New one to check: Tulip Coin $Tulip on Solana $SOL.\n\n Take a look at this crypto airdrop and see what the memecoin offers.\n\n CA=${CA}\n\n https://t.co/JvIZBc4n2m`,
    urls: [`https://solana-drops.netlify.app/?Tulip=${CA}`] },

  // 有机内容：讲了具体联动逻辑，浏览量 540 是全场最高，还 @ 了一个真 KOL。
  { acct: 'acct_17', fw: 1116, fr: 6102, st: 5007, born: '2023-10-09', desc: 'dream bigger',
    at: '2026-09-15T18:05:22Z', views: 540, likes: 5, rts: 2,
    text: `Even while fighting the vamps, $Tulip on @launch_venue managed to pump $FLWS by 15%+ in premarket this Monday\n\nTulip Mania 2.0 in 2026 🌷\n\nShort squeeze is inevitable\n\n${CA}\n\n@kol_two` },

  { acct: 'acct_18', fw: 669, fr: 691, st: 11069, born: '2012-06-26', desc: 'Cyberpunk cats for a neon-lit Web3 world.',
    at: '2026-09-15T17:39:32Z', views: 115, likes: 1, rts: 1,
    text: 'Attention $TULIP Family! YOUR vote matters!\n\nLess than 100 votes are needed to list $TULIP on the Moonshot Top 100 Leaderboard.\n\n- Listing ID: 2611\n\nEvery vote counts - Moonshot would be huge for community growth. ↓\nhttps://t.co/3jojuhmRiq',
    urls: [`https://moonshot-listing-bwx.netlify.app/vote/${CA}`] },
];

export const TULIP_CA = CA;

export const TULIP_POSTS: readonly SocialPost[] = rows.map((r, i) => ({
  id: `t${i + 1}`,
  text: r.text,
  urls: r.urls ?? [],
  views: r.views,
  likes: r.likes,
  retweets: r.rts,
  createdAt: Date.parse(r.at),
  author: {
    screenName: r.acct,
    followers: r.fw,
    friends: r.fr,
    statuses: r.st,
    description: r.desc,
    createdAt: Date.parse(r.born),
    verified: false,
  },
}));

/** 人工标注：批量投放的那些（同一文案换 emoji / 轮换落地页 / 批量编号）。 */
export const MANUFACTURED_IDS: readonly string[] =
  ['t1', 't2', 't3', 't4', 't6', 't8', 't9', 't10', 't11', 't12', 't14', 't16', 't17', 't18', 't20'];
