# 二娃聚合群 API 参考

> 官方文档：https://juhequn.com/skill （源码 `/static/skill.md`，83KB）
> Swagger：https://juhequn.com/docs ｜ OpenAPI JSON：https://juhequn.com/openapi.json
> 索取 Token：管理员微信 `erwaNFT`

## 认证

```bash
curl "https://juhequn.com/api/v1/group_ca/latest?limit=10" \
  -H "Authorization: Bearer $ERWA_API_TOKEN"
```

- Token 存放于项目根目录 `.env` 的 `ERWA_API_TOKEN`（已被 `.gitignore` 排除）
- **禁止**将 Token 写入代码、日志、测试、提示词或文档
- 部分行情类接口（Binance Web3 分类）无需认证

## 本项目 Token 额度（实测 2026-09-11）

| 项 | 值 |
|---|---|
| token_name | `token_9f7142` |
| 有效期至 | 2027-01-01 02:50 |
| 每日额度 | **10,500 次** |
| 重置时间 | 每日 00:00 |

查询用量：`GET /api/v1/token/usage`

## 本项目用到的核心接口

### 1. 观察组 CA 列表 ⭐

```
GET /api/v1/group_ca/board/summary
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `days` | 1 | 最近多少天 |
| `group_name` | — | **群组名称筛选**（本项目传 `镭射猫聊天` / `孙哥聊天` / `猴哥聊天`） |
| `chain` | — | 链筛选 |
| `keyword` | — | 搜索 CA、符号、项目名、叙事、群名或用户名 |
| `sort` | mentions | 排序 |
| `limit` | 60 | 返回 CA 数量 |

**返回结构**：`{ scope, stats, groups, cas, selected_ca, ca_detail }`

`cas[]` 的字段（实测，**一次调用即可满足 A2 筛选**）：

```
ca, symbol, chain, token_name, summary, image_url, icon,
market_cap, latest_market_cap, first_market_cap,   ← A2 市值
liquidity,                                          ← A2 流动性
volume_24h, mention_count, group_count,
x_mention_count, total_mentions, latest_mention_time,
latest_record_id, username, group_name,
twitter, telegram, website,
m5_buys, h1_buys, h6_buys, h24_buys, mc_change
```

`groups[]` 共 45 个群，含本项目的三个观察组。

**实现联调补充（2026-09-11）**：
- `market_cap` / `first_market_cap` 实测可能是带 `K` / `M` 后缀的展示字符串；
  `latest_market_cap` 是数值。客户端优先读取 `latest_market_cap`，为空时严格解析 `market_cap`，不使用宽松的 `parseFloat` 截断后缀。
- `latest_mention_time` 实测为不带时区的 ISO 时间。因服务端时区尚未确认，客户端将此类值映射为 `null`；
  毫秒时间戳和带明确时区的 ISO 时间正常转换。不会把该字段当成上市时间。
- OpenAPI 确认 `days` 范围为 1–365，`limit` 范围为 1–200（默认 60）。

### 2. K 线 ⭐⭐ 最关键

```
GET /api/v1/group_ca/board/ca/{ca_address}/kline?range={range}
```

**⚠️ `interval` 由 `range` 决定，不能单独指定**（实测）：

| `range` | `interval` | 单次 bar 数 | 覆盖 |
|---|---|---|---|
| `24h` | **15m** | 96 | 24 小时 |
| `7d` | **1h** | ≤168 | 7 天 |
| `30d` | **4h** | ≤180 | 30 天 |
| `90d` | **1d** | ≤90 | 90 天 |

传入其他值返回 `422`，校验正则：`^(24h|7d|30d|90d)$`

**返回结构**：

```json
{
  "ca": "...", "range": "24h", "interval": "15m",
  "asset": {...}, "status": "ok", "source": "binance_web3",
  "candles": [
    { "open_time": 1789037100000, "open": 0.0031, "high": 0.0036,
      "low": 0.0031, "close": 0.0032, "volume": ... }
  ]
}
```

- `open_time` 为毫秒时间戳
- 新币数据不足时 bar 数会远少于上限（实测某新币 `7d` 仅 29 根、`30d` 仅 8 根）
- `status` 字段需校验，非 `ok` 时应跳过该 CA

**完整池干跑补充（2026-09-11）**：
- 真实年度查询三群均达到 `limit=200` 上限，不能将该返回列表直接视为已证明完整的年度观察池；当前客户端契约和 OpenAPI 未提供分页参数。
- 部分 `status=ok` 响应也包含 `high < open` 的异常 bar。zod 对 OHLC 边界进行验证，整个不合格窗口抛 `ERWA_VALIDATION`，不写入数据库。
- 24h 行情失败后，调度跳过该 CA 本轮剩余的高周期请求，降低无效调用消耗。

### 3. 链上基础数据（免认证备用源）

```
GET /api/v1/binance/dexscreener/{ca}
```

返回 `{ ca, pairs[] }`，含价格、市值、流动性、交易量。可作为 `board/summary` 的交叉校验。

### 4. 通知推送

| 接口 | 用途 |
|---|---|
| `GET /api/v1/notifications/config` | 读取通知配置 |
| `PUT /api/v1/notifications/config` | 写入配置，请求体：`{ channels[], rules[], deleted_channel_ids[] }` |
| `POST /api/v1/notifications/channels/test` | 测试渠道连通性 |
| `GET /api/v1/notifications/history` | 推送历史（`limit`，默认 50） |
| `GET /api/v1/notifications/options` | 可选项（`days` 默认 30，`limit` 默认 300） |

> 待验证：该套接口能否直接满足需求的 Telegram 推送（含自定义文案 + K 线链接），
> 还是需要自建 Telegram Bot。两条路都可行，见 `03-可行性与约束.md`。

## 其他可用接口（本项目暂未使用）

| 分类 | 端点 | 说明 |
|---|---|---|
| 群 CA | `/api/v1/group_ca/latest` `/search` `/by-ca/{ca}` `/by-username/{u}` `/info/{ca}` `/popular` `/query_group` `/call-leaderboard` | 群聊 CA 多维查询 |
| 群主发言 | `/api/v1/group_owner_messages/latest` `/owners` | |
| AI 总结 | `/api/v1/summaries` `/groups` `/narratives` | 群聊 AI 总结 |
| Binance Web3 | `/api/v1/binance/token/{ca}/info` `/audit` `/token/search` `/market/rank/{category}` `/meme/rush` `/trading/signals` `/address/{addr}/info` | 多数免认证 |
| GMGN | `/api/v1/gmgn/callout/{ca}` `/gmgn/hot-searches` `/gmgn_callouts/latest` `/gmgn_trenches/completed` | 喊单/热搜 |
| KOL | `/api/v1/kol_holdings/board` `/kol_tracker/{slug}/board` `/second_kol` `/us_stock_kol` | KOL 持仓与跟踪 |
| TG | `/api/v1/tg_call/latest` `/tg_call/channels` `/tg_newsflash/latest` | TG Call 频道 |
| 快讯 | `/api/v1/newsflash/latest` `/today` `/date/{date}` | |
| 其他 | `/api/v1/market/prices` `/smart_money` `/popular_http` `/popular_x_mention` `/wind_callouts/latest` `/wind_x/latest` `/translate/zh` | |

完整索引见官方 `/static/skill.md`。
