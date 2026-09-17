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
  constructor(readonly code: 'UNKNOWN_TOOL' | 'INVALID_ARGS', message: string) {
    super(message);
    this.name = 'AgentToolError';
  }
}

const limit = z.number().int().min(1).max(50).default(20);

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

/** 描述要写清「什么时候该调」，模型只能靠这段话判断。 */
export const AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: 'query_pool',
    description: '查询当前观察池成员：符号、链、市值、流动性、来源群、以及 A1~A4 四个条件各自是否通过。'
      + '回答「哪些币接近触发」「某个币为什么没告警」「池子里有哪些 solana 的币」这类问题时使用。',
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
