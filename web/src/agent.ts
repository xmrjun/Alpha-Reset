/**
 * Orbio agent 客户端：模型调用、工具执行与多轮循环。
 *
 * 为什么整个循环跑在浏览器里：key 归用户自己保管，后端只做一次无状态转发，
 * 既不保存也不记录，因此它没有资格替用户把「模型 → 工具 → 模型」这轮对话跑完。
 * 代价是浏览器必须自己管住轮次上限（MAX_ROUNDS），否则模型反复试参数就是死循环。
 *
 * 本文件不含任何界面文案：错误只带 kind，文案由 i18n 决定，
 * 否则中英两份提示迟早会在这里漏掉一半。
 */

/** 已实测支持工具调用的模型。末位是付费兜底，免费额度撞限时降级到同名非 :free 变体。 */
/**
 * 全部取自 Orbio 模型目录中 supported_parameters 含 tools 的条目 —— 不支持工具调用的
 * 模型在这里毫无意义，它无法查数据，只会凭空编。
 * 免费组排在前面：撞额度会自动回退到付费变体，所以默认选免费不会卡住对话。
 * 已实测剔除：thinkingmachines/inkling* 上游不可用；cohere/north-mini-code 即使给了
 * 明确要求用工具的 system 提示仍只回文本 —— 不调工具的模型会一本正经地编数字，
 * 比少几个选项危险得多。加新模型前请先实测它是否真的发起 tool_calls。
 */
export const AGENT_MODELS = [
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'dots-studio/dots-3-note-preview:free',
  'inclusionai/ling-3.0-flash-vl:free',
  'nex-agi/nex-n2.5-pro:free',
  'nex-agi/nex-n2.5-mini:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'openai/gpt-4o-mini',
  'google/gemini-3.8-flash',
  'x-ai/grok-4.20',
  'anthropic/claude-fable-5.1',
] as const;

/** 上下文长度仅用于下拉里的选择提示，不参与任何逻辑。 */
export const MODEL_CONTEXT: Readonly<Record<string, string>> = {
  'nvidia/nemotron-3.5-lightning:free': '1M',
  'nvidia/nemotron-3-super-120b-a12b:free': '262K',
  'dots-studio/dots-3-note-preview:free': '512K',
  'inclusionai/ling-3.0-flash-vl:free': '262K',
  'nex-agi/nex-n2.5-pro:free': '262K',
  'nex-agi/nex-n2.5-mini:free': '262K',
  'google/gemma-4-31b-it:free': '262K',
  'google/gemma-4-26b-a4b-it:free': '262K',
  'openai/gpt-4o-mini': '128K',
  'google/gemini-3.8-flash': '1M',
  'x-ai/grok-4.20': '2M',
  'anthropic/claude-fable-5.1': '1M',
};

export const DEFAULT_MODEL = AGENT_MODELS[0];

/** 工具链最多来回 6 轮：够模型「查池子 → 看覆盖率 → 下结论」，又不至于烧光额度。 */
export const MAX_ROUNDS = 6;

const FREE_SUFFIX = ':free';

export interface AgentTool {
  name: string;
  description: string;
  /** 后端给的是 JSON Schema，前端不解释它，原样塞进 OpenAI 的 tools 字段。 */
  parameters: unknown;
}

export interface ToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

/** OpenAI 兼容的消息形状；tool 消息按规范只带 tool_call_id，工具名从对应 tool_call 里取。 */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type AgentErrorKind =
  | 'missingKey'   // 400 MISSING_KEY：本地后端就拦下了
  | 'key'          // 401
  | 'payment'      // 402
  | 'rate'         // 429
  | 'unavailable'  // 404：后端还没有这组接口
  | 'gateway'      // 502 UPSTREAM_FAILED：后端不回显上游原文，防止夹带 key
  | 'empty'        // 模型返回了 200 但没有可用消息
  | 'rounds'       // 轮次用尽
  | 'network'
  | 'upstream';

export class AgentError extends Error {
  constructor(readonly kind: AgentErrorKind, readonly detail = '') {
    super(`${kind}${detail ? `: ${detail}` : ''}`);
    this.name = 'AgentError';
  }
}

export type AgentStatus = { kind: 'idle' } | { kind: 'thinking' } | { kind: 'tool'; name: string };

export interface AgentRunOptions {
  key: string;
  model: string;
  tools: readonly AgentTool[];
  /** 含 system 的完整上下文；runAgent 只追加，不改写调用方传进来的数组。 */
  messages: readonly ChatMessage[];
  signal: AbortSignal;
  /** 每追加一条消息就回调一次，界面据此实时显示工具调用过程。 */
  onMessages: (messages: ChatMessage[]) => void;
  onStatus: (status: AgentStatus) => void;
  /** 降级到付费变体时回调一次，界面要明确告诉用户开始花钱了。 */
  onFallback: (model: string) => void;
}

/** 后端 400/404 与 Orbio 的 401/402/429 都可能出现，状态码先于响应体决定 kind。 */
function kindFromStatus(status: number, code: string | null): AgentErrorKind {
  if (status === 401) return 'key';
  if (status === 402) return 'payment';
  if (status === 429) return 'rate';
  if (status === 404) return 'unavailable';
  if (status === 400 && code === 'MISSING_KEY') return 'missingKey';
  // 后端把所有上游异常压成 502 UPSTREAM_FAILED，原文一律不回显，这里也就没有 detail 可展示。
  if (status >= 502 && status <= 504) return 'gateway';
  return 'upstream';
}

/** Orbio 的错误码可能是 {error:{code}}、{error:'...'} 或顶层 {code}，三种都认。 */
function errorCode(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  const top = (body as { code?: unknown }).code;
  return typeof top === 'string' ? top : null;
}

function errorMessage(body: unknown, fallback: string): string {
  if (body !== null && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'string') return error;
    if (error !== null && typeof error === 'object') {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message) return message;
    }
  }
  return fallback;
}

/** 部分模型把 content 拆成 [{type:'text',text}]，不摊平就会在界面上渲染成 [object Object]。 */
function flattenContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (part !== null && typeof part === 'object') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
    return '';
  }).join('');
}

function readToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCall[] = [];
  for (const [index, raw] of value.entries()) {
    if (raw === null || typeof raw !== 'object') continue;
    const fn = (raw as { function?: unknown }).function;
    if (fn === null || typeof fn !== 'object') continue;
    const name = (fn as { name?: unknown }).name;
    if (typeof name !== 'string' || !name) continue;
    const args = (fn as { arguments?: unknown }).arguments;
    const id = (raw as { id?: unknown }).id;
    calls.push({
      // 少数模型不回 id，但 tool 结果必须挂回某个 id，缺就本地补一个稳定值。
      id: typeof id === 'string' && id ? id : `call_${index}_${name}`,
      type: 'function',
      function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) },
    });
  }
  return calls;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try { return JSON.parse(text) as unknown; } catch { return text ? { error: { message: text.slice(0, 400) } } : null; }
}

type ChatResult =
  | { kind: 'ok'; content: string; toolCalls: ToolCall[] }
  | { kind: 'free_limit' }
  | { kind: 'error'; error: AgentError };

async function postChat(
  key: string, model: string, messages: readonly ChatMessage[], tools: readonly AgentTool[], signal: AbortSignal,
): Promise<ChatResult> {
  // tools 为空时整个字段省略：部分上游拒绝空数组，而没工具的纯问答仍应能用。
  const payload: Record<string, unknown> = { key, model, messages };
  if (tools.length) {
    payload.tools = tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  let response: Response;
  try {
    response = await fetch('/api/agent/chat', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    return { kind: 'error', error: new AgentError('network') };
  }
  const body = await readBody(response);
  const code = errorCode(body);
  // 免费额度撞限先于状态码判断：它可能以 200 也可能以 4xx 的形式回来。
  if (code === 'free_variant_limit') return { kind: 'free_limit' };
  if (!response.ok) {
    return { kind: 'error', error: new AgentError(kindFromStatus(response.status, code), errorMessage(body, `HTTP ${response.status}`)) };
  }
  const choices = (body as { choices?: unknown } | null)?.choices;
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  const message = choice !== null && typeof choice === 'object' ? (choice as { message?: unknown }).message : undefined;
  if (message === null || typeof message !== 'object') {
    // 200 但没有 choices，多半是上游把错误塞进了响应体，优先把它的话透出来。
    const detail = errorMessage(body, code ?? '');
    return { kind: 'error', error: detail ? new AgentError('upstream', detail) : new AgentError('empty') };
  }
  return {
    kind: 'ok',
    content: flattenContent((message as { content?: unknown }).content),
    toolCalls: readToolCalls((message as { tool_calls?: unknown }).tool_calls),
  };
}

/**
 * 一轮模型调用，内含免费额度降级。
 *
 * 降级只试一次；成功后把付费模型名交还给调用方，让本次对话剩下的轮次继续用它，
 * 否则每一轮都要先撞一次限流再降级，白白多花一次往返。
 */
async function chatOnce(
  key: string, model: string, messages: readonly ChatMessage[], tools: readonly AgentTool[], signal: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[]; model: string }> {
  const first = await postChat(key, model, messages, tools, signal);
  if (first.kind === 'ok') return { content: first.content, toolCalls: first.toolCalls, model };
  if (first.kind === 'error') throw first.error;
  if (!model.endsWith(FREE_SUFFIX)) throw new AgentError('upstream', 'free_variant_limit');
  const paid = model.slice(0, -FREE_SUFFIX.length);
  const second = await postChat(key, paid, messages, tools, signal);
  if (second.kind === 'ok') return { content: second.content, toolCalls: second.toolCalls, model: paid };
  if (second.kind === 'error') throw second.error;
  throw new AgentError('upstream', 'free_variant_limit');
}

/**
 * 执行一次工具调用。
 *
 * 工具层面的失败（参数非法、未知工具）不抛出，而是把错误文本当作工具结果回给模型：
 * 模型据此改参数重试才是正常流程，直接中断对话只会让用户看到一句莫名其妙的红字。
 * 只有网络断了才抛。
 */
async function runTool(call: ToolCall, signal: AbortSignal): Promise<string> {
  let args: unknown;
  // 空参工具（query_coverage / diagnose）模型常常回空串而不是 "{}"，不兜底就直接抛异常。
  try { args = JSON.parse(call.function.arguments || '{}') as unknown; }
  catch { return JSON.stringify({ error: 'INVALID_JSON_ARGUMENTS', hint: 'arguments must be a JSON object' }); }
  let response: Response;
  try {
    response = await fetch('/api/agent/tool', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ name: call.function.name, arguments: args }),
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new AgentError('network');
  }
  const body = await readBody(response);
  if (response.status === 404) throw new AgentError('unavailable');
  if (!response.ok) return JSON.stringify({ error: errorMessage(body, `HTTP ${response.status}`) });
  const result = (body as { result?: unknown } | null)?.result;
  return JSON.stringify(result === undefined ? body : result);
}

/**
 * agent 主循环：调 chat → 有 tool_calls 就逐个执行并以 role:'tool' 追加 → 再调 chat，
 * 直到模型给出纯文本，或撞上 MAX_ROUNDS。
 */
export async function runAgent(options: AgentRunOptions): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [...options.messages];
  let model = options.model;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    options.onStatus({ kind: 'thinking' });
    const turn = await chatOnce(options.key, model, messages, options.tools, options.signal);
    if (turn.model !== model) { model = turn.model; options.onFallback(model); }
    messages.push(turn.toolCalls.length
      ? { role: 'assistant', content: turn.content, tool_calls: turn.toolCalls }
      : { role: 'assistant', content: turn.content });
    options.onMessages([...messages]);
    if (!turn.toolCalls.length) { options.onStatus({ kind: 'idle' }); return messages; }
    for (const call of turn.toolCalls) {
      options.onStatus({ kind: 'tool', name: call.function.name });
      const content = await runTool(call, options.signal);
      messages.push({ role: 'tool', tool_call_id: call.id, content });
      options.onMessages([...messages]);
    }
  }
  options.onStatus({ kind: 'idle' });
  throw new AgentError('rounds');
}

/** 拉取工具清单。后端尚未上线时 404，交给界面显示「服务未就绪」而不是当成普通错误。 */
export async function loadAgentTools(signal: AbortSignal): Promise<AgentTool[]> {
  let response: Response;
  try { response = await fetch('/api/agent/tools', { signal, headers: { Accept: 'application/json' } }); }
  catch (cause) {
    if (signal.aborted) throw cause;
    throw new AgentError('network');
  }
  if (!response.ok) throw new AgentError(kindFromStatus(response.status, null), `HTTP ${response.status}`);
  const body = await readBody(response);
  const tools = (body as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.filter((tool): tool is AgentTool =>
    tool !== null && typeof tool === 'object' && typeof (tool as AgentTool).name === 'string');
}
