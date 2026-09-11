# Alpha-Reset 项目规范

> 本文件供 AI 编码助手自动读取。动手前先读 `docs/04-架构设计.md`（实现契约）。

## 铁律

1. **`src/indicators/` 和 `src/rules/` 必须是纯函数**
   不读数据库、不发网络请求、不调用 `Date.now()`。当前时间一律由参数传入。
   违反此条会导致无法测试，直接判定不合格。

2. **Token 绝不出现在代码里**
   只能 `process.env.ERWA_API_TOKEN` 读取。禁止写进代码、注释、日志、测试夹具、错误信息。
   测试用假 token（如 `tok_test_fake`）。

3. **契约以 `docs/04-架构设计.md` §4 为准**
   函数签名、类型定义、表结构都已定好。觉得契约有问题 → 先提出来，不要擅自改。

4. **策略阈值一律从 `config/strategy.json` 读，代码里禁止写死**
   上市时长、市值区间、流动性、48 bar、RPS 阈值、RSI 60/50、MA39、冷却轮数……全部来自 `cfg`。
   规则函数签名带 `cfg: StrategyConfig`，出现魔法数字判定不合格。
   `$comment` 开头的键是注释，loader 要忽略。

5. **API 响应必须经 zod 校验后才入库**
   外部数据一律不可信。`status !== 'ok'` 要抛出可识别的错误，不能静默返回空数组。

6. **不要为了让测试通过而弱化测试**
   测试失败说明实现有问题，改实现不改断言。

## 技术栈

Node 24 + TypeScript（ESM）+ better-sqlite3 + zod + node:test

⚠️ 本机 node 装在 nvm：`/root/.nvm/versions/node/v24.21.0/bin`。
非交互 shell 不加载 `.bashrc`，脚本里要显式 `export PATH=...`。

## 命令

```bash
npm test              # 跑测试
npx tsc --noEmit      # 类型检查
npm run dry-run       # 干跑一轮，不推送
```

## 提交前自查

```bash
grep -rn "tok_" src/ test/          # 必须无输出
npx tsc --noEmit                    # 必须无错误
npm test                            # 必须全绿
git status --porcelain | grep .env  # 必须无输出（.env 不能进仓库）
```

## 业务要点（易错处）

- **30 分钟 K 线 API 不提供**，必须用 15m 两两合成（`merge15mTo30m`）
- **RPS 是相对排名**，必须对观察组全池计算，不能只算筛选后的子集
- **存续不足的 CA 从 RPS 排名中剔除**，不是记 0 参与排名
- **"历史新高"查的是数据库累积的全部历史**，不只是本次 API 返回的窗口
- A1 上市时间用免认证 `dexscreener` 的 `pairCreatedAt`（多交易对取最早）；取不到时**跳过该 CA**，不可默认通过
- ⚠️ **免认证的 `binance/*` 不占 `used_today`，但受账户级限流** —— 同机 yaobi 项目 2026-09-01 曾因轮询
  `binance/dexscreener` 把额度打光导致全站 429。**不要无节制并发调用**，调用前后各读一次 `token/usage`，
  遇 429 按 `Retry-After` 退避并持久化冷却
- **A2 用 `board/summary` 自带的 `latest_market_cap`/`liquidity`，不要为此调 dexscreener**
- **A1 的 `pairCreatedAt` 是静态值 → 查一次永久缓存**，只对本系统首次见到的新 CA 查询
- **禁止调用 `PUT /api/v1/notifications/config`** —— 它会修改**账号级**配置，可能影响同账号的其他项目
- **单元测试一律 mock fetch**，不要打真实 API（当天配额是共享的，调试几轮就耗光）
- `board/summary` 的 `limit` 上限 **200**，传 201 **静默返回 0 不报错** —— 客户端必须夹紧到 200
- `GET /api/v1/group_ca` 的 `group_name` 参数**失效**，别用它做群筛选
- 观察池按 `cfg.pool.rankBy` 降序截断到 `cfg.pool.maxCandidates`；
  启动时必须自检 `maxCandidates` 是否超出配额推导值，超了就报错退出
