# Alpha-Reset

观察组代币（CA）创新高回调监控与告警系统。

数据源：二娃群数据 + GeckoTerminal 行情 ｜ 推送：Telegram ｜ 前端：https://alpha.0xdydx.top（暖色）

当前行情与 RPS 契约见 [docs/13-接入与口径修正.md](docs/13-接入与口径修正.md)：固定交易对、已收盘数据、精确端点、完整池保守区间；旧历史保留但不混入新来源序列。下文部分历史验收记录描述的是修正前版本。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/01-需求规格.md](docs/01-需求规格.md) | 结构化需求：观察组、筛选条件 A1–A6、小前提、补充标签、RPS 口径 |
| [docs/02-二娃API参考.md](docs/02-二娃API参考.md) | API 认证、核心接口、字段说明、额度 |
| [docs/03-可行性与约束.md](docs/03-可行性与约束.md) | ⚠️ **开工前必读** — 实测发现的三个硬约束与架构建议 |
| [docs/04-架构设计.md](docs/04-架构设计.md) | **实现契约** — 技术栈、分层、表结构、函数签名、验收标准 |
| [docs/05-实现任务清单.md](docs/05-实现任务清单.md) | 分阶段任务，opencode 按此执行 |
| [docs/06-前端设计.md](docs/06-前端设计.md) | 前端契约 — 暖色设计系统、页面、图表规范、部署 |
| [docs/10-K线数据源.md](docs/10-K线数据源.md) | **K 线为何用 GeckoTerminal** — 按链的可用性实测、深度对比、限流 |
| [docs/12-上游响应与超时.md](docs/12-上游响应与超时.md) | 上游响应时间实测与超时依据 —— 空轮问题的根因 |
| [docs/11-RPS覆盖率调优.md](docs/11-RPS覆盖率调优.md) | 四次定位过程、容差与阈值的实测依据 |
| [docs/08-主链路跑通记录.md](docs/08-主链路跑通记录.md) | 端到端跑通的结果与三个真问题的修复 |
| [docs/09-部署运维.md](docs/09-部署运维.md) | 访问地址、systemd、备份、日志、已知坑 |
| [docs/13-接入与口径修正.md](docs/13-接入与口径修正.md) | **当前行情契约** — 序列身份隔离、五档精确端点、实时展示 |
| [docs/14-动态观察池与限流.md](docs/14-动态观察池与限流.md) | 取消 132 上限后的名单/采集/计算三任务拆分与速率预算 |
| [docs/15-GMGN联合接入实测.md](docs/15-GMGN联合接入实测.md) | GMGN 接入前的真实探测：两源偏差为何不能拼接 |
| [docs/16-GMGN正式评分.md](docs/16-GMGN正式评分.md) | 双来源采集、同 T 不换源、下一 T 受控切换 |
| [docs/17-小时评分与轻量推送.md](docs/17-小时评分与轻量推送.md) | 计算改为每小时、3 分钟补算门、页面停止重读全池历史 |
| [docs/18-失活剔除与无市场判定.md](docs/18-失活剔除与无市场判定.md) | **排名分母口径** — 停更盘与无交易对 CA 的证据化剔除 |
| [AGENTS.md](AGENTS.md) | AI 编码助手自动读取的项目规范与铁律 |

## 🔐 安全须知

**配置绝不进公开仓库。**

- 机密只存放在 `.env`（权限 600，已被 `.gitignore` 排除）
- 提交前自查：`git status --porcelain | grep -E "^\?\?.*\.env$"` 应无输出
- `.env.example` 是**唯一**可提交的配置样本，其中 Token 为占位符
- 禁止将 Token 写入代码、日志、测试夹具、提示词或文档
- Token 一旦外泄：联系管理员微信 `erwaNFT` 重置

```bash
cp .env.example .env   # 新环境部署时
vim .env               # 填入真实 Token
chmod 600 .env
```

## 环境

| 项 | 值 |
|---|---|
| 服务器 | 212.237.218.59（芬兰，Ubuntu 24.04，6C/11G） |
| Node | v24.21.0（nvm），npm 11.19.0 |
| 项目路径 | `/root/Alpha-Reset` |

> ⚠️ 非交互 SSH 不加载 `.bashrc`，node 不在 PATH。脚本中需显式：
> `export PATH="/root/.nvm/versions/node/v24.21.0/bin:$PATH"`

## 三个必须先知道的约束

1. **30 分钟 K 线 API 不提供** —— 必须用 `range=24h` 的 15m 数据两两合成
2. **A3.1 与 A3.2 在现有数据下等价** —— 30m 能回溯的历史仅 24 小时，需自建时序库累积
3. **每日 10,500 次额度** —— 差异化刷新策略下池子上限约 134 个 CA

详见 [docs/03-可行性与约束.md](docs/03-可行性与约束.md)。

## 本地开发

在项目根目录执行：

```bash
export PATH="/root/.nvm/versions/node/v24.21.0/bin:$PATH"
npm ci
npx tsc --noEmit
npm test
npm run build
npm run build:web
```

- `npm test` 使用 mock API 和临时 SQLite，不读取真实 Token、不调用外部接口。
- 编译产物位于 `dist/src/` 与 `dist/test/`；应用配置入口为 `dist/src/config.js`。
- `.env` 由 Node 原生加载，系统环境变量优先；缺少 `ERWA_API_TOKEN` 时明确报错。
- 策略阈值集中在 [`config/strategy.json`](config/strategy.json)，由 `loadStrategy()` 校验，递归忽略 `$comment` 前缀键。
- 存储模块通过 `createCandleStore(db)` 等工厂注入数据库。`getCandles()` **倒序**返回，传给指标前须转成升序；省略 `limit` 读取全部累积历史。
- `npm run dry-run` 拉取真实数据、累积入库并打印每个 CA 的判定，Telegram 只打印不发送；年度大池首轮可能运行十余分钟。

### 启动页面与调度

分别在两个终端启动本地 API 和前端：

```bash
npm run web       # JSON API：127.0.0.1:8787
npm run dev:web   # 前端：127.0.0.1:5173，/api 自动代理到 8787
```

两个服务均绑定回环地址；远程开发可使用 SSH 端口转发访问。
需要运行持续监控时执行 `npm start`；Telegram 配置使用 `.env` 中的 `TG_BOT_TOKEN` / `TG_CHAT_ID`。
`QUOTA_TIMEZONE` 控制本地配额记账日，默认 UTC，需与数据源实际重置时区一致；`WEB_PORT` 默认 8787。

前端构建输出为 `web/dist/`，独立于后端的 `dist/`。默认**绿涨红跌，涨空心/跌实心**；
构建时设置 `VITE_CANDLE_SCHEME=cn` 可交换涨跌颜色。
`deploy/` 提供 nginx 与两个 systemd 服务模板。静态产物发布目录为 `/var/www/alpha-reset`，域名和 HTTPS 部署见前端设计文档。

### 浏览器验收

```bash
npx playwright install --with-deps chromium   # 首次安装测试浏览器及系统依赖
npm run test:web
```

测试覆盖观察池搜索/筛选/排序、详情周期切换与多副图、明暗模式、移动端告警筛选、空状态和错误重试。

## 已确认口径与真实数据限制

- **A3 跨轮有效**：记录的新高持续满足对应条件，同类新高更新后重置等待。规则通过 `RuleInput.cfg` 接收所有阈值。
- **已收盘数据**：回调等待要求存在足够的后续 bar；断档或陈旧周期不生成 RSI/低量提醒。
- **精确 RPS 端点**：N 周期涨幅需要相隔 N 个周期的收盘价；小时线仅在收盘时间精确对齐时补端点，否则等本地历史累积。
- **池覆盖限制**：真实干跑三群都达到 API 单次 200 条上限，最新一轮合并后处理了 494 条记录，无法确认覆盖全部年度 CA。
  该规模也超过文档中 10,500 次日额度下约 134 CA 的预算。观察池不完整或当轮 24h 请求失败时，调度暂停该轮 RPS 告警，前端显示数据质量提示。
- **行情质量**：实测有非 `ok` 状态，以及 `high < open` 等异常 OHLC。客户端严格拒绝不合格响应；24h 失败时直接跳过该 CA 的高周期拉取。
- **上市时间**：当前使用 90d 最早 K 线估算，再回退 `first_seen_at`；token info 的上市字段仍待数据源确认。无时区的提及时间保留为未知。

下一项运行前置工作是确认实时观察池范围与完整列表的获取方式；公开域名、证书和常驻服务启用属于部署阶段。

## 状态

- [x] 需求整理
- [x] API 调研与实测
- [x] 可行性分析
- [x] 项目骨架（Node 24 / TypeScript ESM / 配置校验）
- [x] 集中式策略配置（含 `$comment` loader）
- [x] 数据层（K 线拉取 + 时序落库）
- [x] 指标层（30m 合成、RSI、MA39、RPS）
- [x] 规则引擎（A1–A6、小前提、补充标签）
- [x] 推送（Telegram 客户端 + K 线链接 + 合并去重 + 干跑）
- [x] 调度（差异化刷新、配额保护、完整 dry-run）
- [x] Web JSON API（四端点、仅回环监听）
- [x] 前端（暖色三页面、明暗模式、K 线副图与标记）
- [ ] 运行池完整性与配额规模确认
- [ ] 公网部署及真实 Telegram 收件验收

最近验收：**86 项后端测试 + 4 项浏览器测试通过**，前后端类型检查与构建通过。
真实 `npm run dry-run` 已完整执行：处理 494 条记录、364 次行情请求失败/校验拒绝，`poolComplete=false`，零推送。
真实 SQLite → JSON API → 浏览器联调通过，页面访问新增上游调用数为 0。
