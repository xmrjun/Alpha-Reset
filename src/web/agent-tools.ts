import { z } from 'zod';

/**
 * Agent 内核：把本系统的只读查询包成模型可调用的工具。
 *
 * 设计约束：
 * - 只读。工具不得写库、不得触发采集或评分，agent 崩了也不能影响告警管线。
 * - 参数一律经 zod 收口后再下推查询层，模型产生的幻觉参数在这里被拦住。
 * - 每个工具都声明 additionalProperties:false，未声明的字段直接拒绝。
 * - 默认 limit 保守，避免模型一句话把整个库拉走撑爆上下文。
 */

export class AgentToolError extends Error {
  constructor(
    readonly code: 'UNKNOWN_TOOL' | 'INVALID_ARGS' | 'NOT_CONFIGURED' | 'BUDGET_EXHAUSTED' | 'UPSTREAM_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'AgentToolError';
  }
}

const limit = z.number().int().min(1).max(50).default(20);

/**
 * 合约地址：EVM 的 0x+40 hex，或 base58（Solana / Tron）。
 *
 * 这个值会被原样送进 X 的搜索接口，而每次搜索都花运营方的钱。只校验长度的话，
 * 任意字符串都能进去，站点就成了别人免费用的匿名搜索服务 —— 所以这里必须是
 * 地址形态，不能是搜索词。
 */
const contractAddress = z.string().trim()
  .regex(/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/);

const schemas = {
  query_pool: z.strictObject({
    chain: z.string().min(1).max(32).optional(),
    group: z.string().min(1).max(64).optional(),
    hit: z.enum(['0', '1']).optional(),
    limit,
  }),
  query_alerts: z.strictObject({
    ca: z.string().min(1).max(256).optional(),
    tag: z.string().min(1).max(64).optional(),
    from: z.number().int().nonnegative().optional(),
    to: z.number().int().nonnegative().optional(),
    limit,
  }),
  query_coverage: z.strictObject({}),
  social_check: z.strictObject({ ca: contractAddress }),
  alert_performance: z.strictObject({
    from: z.number().int().nonnegative().optional(),
    to: z.number().int().nonnegative().optional(),
    limit,
  }),
  diagnose: z.strictObject({}),
} as const;

export type AgentToolName = keyof typeof schemas;

export interface AgentToolDefinition {
  name: AgentToolName;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

/**
 * 随每次 social_check 结果一起回给模型的边界说明。
 *
 * 线上实测过两种幻觉：模型点评「这条推写得有情绪有立场」（工具根本没有原文），
 * 以及把「没出告警」归因于社交热度低（告警只看 A1~A4）。工具描述容易被长上下文
 * 冲淡，写进结果里模型在当下就能看到。
 */
export const SOCIAL_RESULT_NOTE =
  '本结果不含推文原文，请勿评价任何推文的写法或语气，也勿推断某条推是谁发的；'
  + '社交面不参与 A1~A4 告警判定，不要用它解释某个币为何没告警。';

/**
 * 随 query_pool 结果返回。displayRps 可能来自上一轮而 rpsScores 全是 null，
 * 模型一定会报那个有数字的，并说成「A4 用的排名」—— 和把社交热度说成告警原因
 * 是同一类错误：拿不参与判定的数字去解释判定结果。
 */
export const POOL_RESULT_NOTE =
  'displayRps 仅供显示、可能来自上一轮，不参与 A4 判定；calculationPending 为真表示该成员本轮尚未计算，'
  + '此时不要用 displayRps 代替 rpsScores。groupName 只表示某个群提到过这个合约，不等于该群在推荐它。';

/**
 * 随 query_alerts 结果返回。这个工具吐的是事后收益率与胜率，对一个公开可访问的
 * 加密货币站点，把它讲成预测是风险最高的一面。controlSince 之前的统计只有触发组、
 * 没有对照组，必须让模型看见这句话，否则它会宣称「跑赢大盘」。
 */
export const ALERTS_RESULT_NOTE =
  '这里的胜率与收益率是事后统计，不是预测，不得据此给出任何买卖、仓位或入场时机建议；'
  + 'controlSince 之前的轮次只有触发组、没有对照组，不能当作跑赢基准的证据。';

/**
 * 随 alert_performance 返回。价格变化不等于收益：没有入场价、没有滑点、没有手续费，
 * 也没有仓位。模型很容易把「涨了 50%」说成「赚了 50%」。
 */
export const PERFORMANCE_RESULT_NOTE =
  '这是告警时刻收盘价与最新收盘价的价格变化，不是收益率 —— 没有入场价、滑点、手续费和仓位；'
  + 'priceAsOf 是最新价的时间，离现在太远说明该币已经没有新行情；'
  + 'unavailable 的条目不能当作零涨跌。不得据此给出任何买卖建议。';

/** 描述要写清「什么时候该调」，模型只能靠这段话判断。 */
export const AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: 'query_pool',
    description: '查询当前观察池成员：符号、链、市值、流动性、来源群、以及 A1~A4 四个条件各自是否通过。'
      + '回答「哪些币接近触发」「某个币为什么没告警」「池子里有哪些 solana 的币」这类问题时使用。'
      + '结果里一并带上 thresholds，即 A1~A3 各自的门槛值 —— 解释某个条件为什么没过时'
      + '必须引用这些门槛值，不要自己编区间。',
    parameters: {
      type: 'object',
      properties: {
        chain: { type: 'string', description: '按链过滤，如 solana / bsc / robinhood / arc' },
        group: { type: 'string', description: '按来源群名过滤' },
        hit: { type: 'string', enum: ['0', '1'], description: '1 只看当前有告警标签的，0 只看没有的' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数，默认 20' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'query_alerts',
    description: '查询历史告警：触发时间、币种、标签、是否已推送，以及事后表现。'
      + '回答「今天出了哪些告警」「某个币历史上触发过几次」「告警后涨跌如何」时使用。',
    parameters: {
      type: 'object',
      properties: {
        ca: { type: 'string', description: '只看某个合约地址' },
        tag: { type: 'string', description: '按告警标签过滤，如 30m_ath_pullback' },
        from: { type: 'integer', description: '起始时间，毫秒时间戳' },
        to: { type: 'integer', description: '结束时间，毫秒时间戳' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数，默认 20' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'query_coverage',
    description: '查询最新一轮 A4 的五档 RPS 覆盖率，以及缺口是怎么构成的'
      + '（缺当期价、缺窗口起点、已失活、流动性不足各多少个）。'
      + '回答「为什么没有告警」「覆盖率为什么不达标」时必须先调这个。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'social_check',
    description: '查一个合约地址在 X(Twitter) 上的讨论质量。'
      + '返回字段：total 提及条数、manufactured 其中判定为批量刷量的条数、botRatio 刷量占比、'
      + 'clusters 模板簇数、medianViews 浏览量中位数、kols 粉丝达标且非刷量的账号、'
      + 'mentions 正文里被 @ 到的账号（这些是被提到的第三方，不是发帖人，更不是提问者本人）、'
      + 'verdict 总体判定、posts 每条的得分与命中的特征标记。'
      + '注意提及数是反向指标 —— 刷量占比高说明有人在花钱买量，通常是出货前兆，'
      + '不要把「提及多」当利好来回答，也不要建议用户去增加曝光或找更多账号转发。'
      + '重要边界：本工具不返回推文原文，只有上述统计量，'
      + '所以不得评论任何一条推的文字内容、写法或语气，也不得推断某条推是谁发的。'
      + '另一条边界：社交面不参与 A1~A4 告警判定，'
      + '告警只由年龄、规模、回调形态、RPS 排名四项决定，'
      + '因此不参与、也不决定告警是否触发，不要用社交热度解释某个币为什么没告警。'
      + '回答「这个币在推特上靠不靠谱」「热度是不是刷的」「有没有真人在讨论」时使用。'
      + '这个工具会请求外部接口、有每日额度，同一个合约十分钟内只实际查一次。',
    parameters: {
      type: 'object',
      properties: {
        ca: { type: 'string', description: '合约地址，从 query_pool 或 query_alerts 的结果里取' },
      },
      required: ['ca'],
      additionalProperties: false,
    },
  },
  {
    name: 'alert_performance',
    description: '对比一段时间内触发过告警的币：告警那一刻的收盘价，和该币最新的收盘价，'
      + '算出至今的价格变化，并汇总涨了几个、跌了几个、几个算不出来。'
      + '回答「9 月 20 号告警的币现在怎么样了」「上周推荐的哪些涨了哪些跌了」这类问题时使用。'
      + 'from / to 是毫秒时间戳，不传则默认最近 7 天；同一个币在窗口内多次告警时按最早那次算。'
      + '两端价格取自同一个行情序列，结果里的 source 说明是哪个源。'
      + '重要：这是价格变化而不是收益率，没有入场价、滑点和手续费，不要说成「赚了多少」，'
      + '也不要据此给出买卖建议。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'integer', description: '起始时间，毫秒时间戳' },
        to: { type: 'integer', description: '结束时间，毫秒时间戳' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回几个币，默认 20' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'diagnose',
    description: '查询系统健康度：三个行情源各自承担多少成员、采集器状态与限流、'
      + '观察池发现是否成功、配额用量。回答「系统是不是坏了」「数据为什么不更新」时使用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** 模型给的参数一律先过这里；任何越界、未知取值、未声明字段都在此拦住。 */
export function parseToolArgs<K extends AgentToolName>(name: K, raw: unknown): z.infer<typeof schemas[K]>;
export function parseToolArgs(name: string, raw: unknown): Record<string, unknown>;
export function parseToolArgs(name: string, raw: unknown): Record<string, unknown> {
  const schema = (schemas as Record<string, z.ZodTypeAny>)[name];
  if (!schema) throw new AgentToolError('UNKNOWN_TOOL', '未知工具');
  const parsed = schema.safeParse(raw ?? {});
  // 不回显模型传来的原始值：它可能很长，也可能夹带无关内容。
  if (!parsed.success) throw new AgentToolError('INVALID_ARGS', '工具参数不合法');
  return parsed.data as Record<string, unknown>;
}
