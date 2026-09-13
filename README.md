# Alpha-Reset

**[English](README.md) · [中文](README.zh-CN.md)**

A production monitoring system that watches tokens discussed in private trading groups and alerts when one pulls back from a fresh high — with every claim it makes traceable to stored evidence.

**Live:** <https://alpha.nbmrjun.top> · no login, read-only, served from local data.

---

## Orbio Build Week

`$ORBIO` trades on **Robinhood Chain**. Robinhood Chain is also the **largest chain in this system's watchlist — 108 of 245 tokens (44%)**, and supporting it is why the market-data source was migrated to GeckoTerminal in the first place (the original provider has no Robinhood Chain candles at all).

`$ORBIO` itself is already monitored, not as a demo but because someone mentioned it in one of the three watched groups:

**→ <https://alpha.nbmrjun.top/ca/0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3>**

| | |
|---|---|
| Chain | robinhood |
| A1 (age) / A2 (size) | pass / pass — market cap $23.8M, liquidity $687K, both inside the configured band |
| Accumulated candles | 1,082 × 15m ≈ 11.3 days, from a GMGN token series |
| How it entered the pool | mentioned in one of the three observed groups |

## What it does

1. **Discover** — every 5 minutes, pull the tokens mentioned in three private trading groups and publish a deduplicated watchlist. All three groups must succeed, or the previous complete list is kept.
2. **Collect** — continuously sweep the watchlist for 15m candles through two independent, rate-limited queues (GeckoTerminal 8 req/min, GMGN 30 req/min), each with its own cooldown and fair-ordering that survives restarts.
3. **Score** — on the hour, read one consistent snapshot out of local SQLite and evaluate the rules. No network call is inside the scoring transaction.
4. **Alert** — deliver merged Telegram messages with per-tag cooldowns, and store the indicator snapshot taken at trigger time.

A token alerts only when **A1 ∧ A2 ∧ A3 ∧ A4** all hold: old enough, inside the size band, pulled back from a recorded high, and strong on relative-strength ranking.

## Four design choices worth reading the code for

### 1. Rules are pure functions, enforced by grep

`src/indicators/` and `src/rules/` may not call `fetch`, read `Date.now()`, or touch the database. Every input arrives as an argument. This is not a convention — it is the acceptance criterion:

```bash
grep -rn "fetch(\|Date\.now()" src/indicators src/rules   # must print nothing
```

That property is what makes the rule layer testable without mocks and reviewable without running it.

### 2. Missing data narrows a range instead of inventing a number

Relative strength is a cross-sectional ranking, so it needs every member priced at the same instant. Real pools do not cooperate. Rather than dropping absent members (which flatters the score) or guessing a price, the ranking emits an **interval**:

```
lower = (1 − (rank + missing) / N) × 100     // every missing member beats you
upper = (1 − rank / N) × 100                 // every missing member loses to you
```

A rule fires only when `lower` alone clears the threshold. Exact scores are published only when the ranking is genuinely complete — otherwise the score stays `null` and the page shows `≥81.2` or `52.3–75.0` instead of a fabricated point value.

### 3. Exclusion requires upstream evidence, never local absence

A watchlist accumulates dead tokens, and they drag coverage below the threshold forever. Excluding them is correct — but only when there is positive proof the market is gone, not when the local fetch merely failed:

- **has history** → excluded when the newest *upstream* candle is older than `inactiveAfterBars`, verified by querying the provider directly and confirming its latest bar matches what is stored locally
- **no history** → excluded only on `dexStatus === 'absent'`, meaning DexScreener answered `HTTP 200` with `pairs: null`

`dexStatus` distinguishes `absent` (upstream answered, no market exists) from `error` (the request failed). A collection outage produces `error`, keeps members in the denominator, drops coverage, and correctly blocks alerting instead of quietly shrinking the pool. See [docs/18](docs/18-失活剔除与无市场判定.md).

### 4. The system measures its own signals against a control

Every scoring timestamp records **all members that passed A1∧A2 and had a close price** — not just the ones that alerted. `alerted` separates the two groups in the same table, so the honest question can be asked: *did the triggered tokens do better than the qualifying tokens that did not trigger?*

Forward returns at 1h / 4h / 24h are settled later from local candles, using the **same series** both endpoints came from. Zero upstream requests. Results are at `/api/outcomes` and on the alert-history page.

The first thing this measurement did was contradict an impression. Over 94 historical alert events the triggered group's median 1h return was **−1.2%**, not the win it looked like from eyeballing recent deliveries. It also showed all three `low_vol_*` tags with negative medians while `60m_2d_high_pullback` and `rsi_lt50_60m` were the only consistently positive ones.

Those numbers are **not yet actionable**: 17 assets, top three accounting for half the sample, three days, no exit rule, and — critically — the control group is empty for all historical rounds because the qualifying set per round was never persisted. The UI says so in place of the comparison rather than letting an empty control read as outperformance. Control data accrues from the moment the feature shipped.

## Other properties

- **Two market sources are never spliced.** A series is identified by source + chain + contract + pool + currency + format version. GeckoTerminal is pool-scoped, GMGN is token-scoped; measured close-price divergence between them is 0.2–0.8% median, so one source's new price is never written into another's history. Source is frozen for a scoring timestamp and only switched, deliberately, at the next one.
- **Late data revises, it does not restart.** The same timestamp is recomputed at most every 3 minutes, deduplicated by an input fingerprint, and republished with an incremented revision.
- **The page never calls upstream.** Lists and stats are built from the saved calculation; a shared WebSocket pushes local snapshots. More viewers cost zero additional upstream requests.
- **Bilingual UI.** English or Chinese by browser language, with a manual toggle that persists and updates `<html lang>`.

## Current numbers

| | |
|---|---|
| Watchlist | 245 tokens across 8 chains |
| Stored candles | 213,915 × 15m; deepest single series 1,095 bars |
| Active series | 164 GeckoTerminal (pinned pool) + 110 GMGN (token) |
| Historical contracts archived | 1,951 |
| Alerts recorded / delivered | 280 / 41 |
| Tests | 297 backend + 18 browser, all passing |
| Source | ~6,500 lines of app code, ~6,900 lines of tests |

## Stack

Node 24 · TypeScript (ESM, strict) · better-sqlite3 · zod · `node:test` · Vite + React 19 + lightweight-charts · Playwright

## Run it

```bash
npm ci
npm test            # 297 backend tests; mock upstreams, temp SQLite, no network, no real token
npm run test:web    # 18 browser tests (needs: npx playwright install --with-deps chromium)

cp .env.example .env && chmod 600 .env   # fill in credentials
npm run web         # JSON API on 127.0.0.1:8787
npm run dev:web     # UI on 127.0.0.1:5173, proxies /api
npm start           # the scheduler
npm run dry-run     # real upstream reads, no Telegram delivery
```

Both services bind to loopback only. `deploy/` holds nginx and systemd templates.

## Configuration

Strategy thresholds live in [`config/strategy.json`](config/strategy.json), validated by `loadStrategy()`, which recursively ignores `$comment`-prefixed keys. `config/strategy.local.json` overrides it and is git-ignored — the repository copy carries placeholder group names.

**Secrets never enter the repository.** They live only in `.env` (mode 600, git-ignored); `.env.example` is the only committed sample and contains placeholders.

## Documentation

Design notes are written as a running record — each one states what was measured, what it cost, and what was rejected. They are in Chinese.

| Document | Topic |
|---|---|
| [02](docs/02-二娃API参考.md) | Group data API: auth, endpoints, quota |
| [03](docs/03-可行性与约束.md) | Hard constraints found by measurement before any code |
| [04](docs/04-架构设计.md) | Implementation contract: layers, schema, signatures |
| [06](docs/06-前端设计.md) | Frontend contract: design system, pages, charts |
| [09](docs/09-部署运维.md) | Deployment, systemd, backups, known traps |
| [10](docs/10-K线数据源.md) | Why GeckoTerminal: per-chain availability and depth |
| [12](docs/12-上游响应与超时.md) | Upstream latency measurements behind the timeout values |
| [13](docs/13-接入与口径修正.md) | **Current market contract** — series identity, exact endpoints |
| [14](docs/14-动态观察池与限流.md) | Dynamic watchlist, task split, rate budget |
| [15](docs/15-GMGN联合接入实测.md) | Measured divergence: why two sources cannot be spliced |
| [16](docs/16-GMGN正式评分.md) | Dual-source scoring and controlled switchover |
| [17](docs/17-小时评分与轻量推送.md) | Hourly scoring, revision gate, lightweight reads |
| [18](docs/18-失活剔除与无市场判定.md) | **Ranking denominator** — evidence-based exclusion |
| [AGENTS.md](AGENTS.md) | Rules AI coding assistants read automatically |

## Limits worth stating

- **Coverage is the binding constraint, not the rules.** With a free market-data tier the full sweep takes ~30 minutes, so a signal can land up to ~50 minutes after the close it is based on. Raising the rate limit — not changing the strategy — is the fix.
- **"All-time high" means all-time within this system's stored series.** Depth is bounded by what has been accumulated since the series was pinned, and by the provider's single-page limit.
- **Group lists may be truncated.** Each group returns at most 200 entries per call; when that ceiling is hit the page says so rather than implying the list is complete.
- **Not financial advice.** This is a monitoring tool. It reports what the rules matched and the evidence behind it; it does not recommend anything.
