import type { ChatMessage, ToolCall } from './agent.js';

/**
 * 聊天记录的本地持久化。
 *
 * 导航栏是普通 <a>，切页面等于整页重载，React 里的对话会全部丢掉，
 * 所以对话必须自己落到 localStorage。这个模块只做纯计算，不碰 storage，
 * 读写由调用方包 try —— 隐私模式下 localStorage 会直接抛异常。
 *
 * 裁剪有个硬约束：OpenAI 兼容接口要求每条 tool 消息前面都有发起它的
 * assistant.tool_calls，每个 tool_call 也都要有结果。裁剪时乱下刀会留下
 * 孤儿消息，下次提交直接被上游拒绝，表现成「聊天页一发就报错」。
 * 所以只在用户提问处切，并且丢掉尾部没拿到结果的那一轮。
 */

export const CHAT_STORAGE = 'alpha-agent-chat';

/** 条数上限：够回看十几轮，又不至于让重新提交时上下文爆掉。 */
export const MAX_MESSAGES = 60;

/** 字符上限：localStorage 一般 5M 字符一个源，这里只占一小部分，给 key/model 留足余量。 */
export const MAX_CHARS = 200_000;

/** 返回可以安全结尾的位置：尾部若有没拿到结果的 tool_calls，从那条 assistant 起全丢。 */
function closedEnd(list: readonly ChatMessage[]): number {
  const pending = new Set<string>();
  let firstOpen = -1;
  list.forEach((message, index) => {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      if (firstOpen < 0) firstOpen = index;
      for (const call of message.tool_calls) pending.add(call.id);
    } else if (message.role === 'tool') {
      pending.delete(message.tool_call_id);
      if (pending.size === 0) firstOpen = -1;
    }
  });
  return pending.size === 0 || firstOpen < 0 ? list.length : firstOpen;
}

/** 裁剪到可以直接再次提交给上游的形状：以用户提问开头，工具调用成对。 */
export function trimHistory(messages: readonly ChatMessage[]): ChatMessage[] {
  // system 由前端每次重新拼，存下来只会和新版提示词打架。
  const usable = messages.filter((message) => message.role !== 'system');
  const closed = usable.slice(0, closedEnd(usable));

  let start = closed.length;
  let chars = 2;
  for (let i = closed.length - 1; i >= 0; i -= 1) {
    if (closed.length - i > MAX_MESSAGES) break;
    const size = JSON.stringify(closed[i]).length + 1;
    if (chars + size > MAX_CHARS) break;
    chars += size;
    start = i;
  }
  // 切口只能落在用户提问上，否则会留下没有母消息的工具结果。
  while (start < closed.length && closed[start]?.role !== 'user') start += 1;
  return closed.slice(start);
}

function asToolCalls(raw: unknown): ToolCall[] | null {
  if (!Array.isArray(raw)) return null;
  const calls: ToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const call = item as Record<string, unknown>;
    const fn = call.function as Record<string, unknown> | undefined;
    if (typeof call.id !== 'string' || !fn || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') return null;
    calls.push({ id: call.id, type: typeof call.type === 'string' ? call.type : 'function',
      function: { name: fn.name, arguments: fn.arguments } });
  }
  return calls;
}

/** 存储里的东西可能是旧版本写的、也可能被人手改过，一律当作不可信输入校验。 */
function asMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const content = item.content;
  if (typeof content !== 'string') return null;
  if (item.role === 'user' || item.role === 'system') return { role: item.role, content };
  if (item.role === 'tool') {
    return typeof item.tool_call_id === 'string' ? { role: 'tool', tool_call_id: item.tool_call_id, content } : null;
  }
  if (item.role !== 'assistant') return null;
  if (item.tool_calls === undefined) return { role: 'assistant', content };
  const calls = asToolCalls(item.tool_calls);
  return calls ? { role: 'assistant', content, tool_calls: calls } : null;
}

/** 空历史返回空串，调用方据此把这条存储删掉而不是留个 "[]"。 */
export function encodeHistory(messages: readonly ChatMessage[]): string {
  const kept = trimHistory(messages);
  return kept.length === 0 ? '' : JSON.stringify(kept);
}

export function decodeHistory(raw: string): ChatMessage[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const clean: ChatMessage[] = [];
  for (const item of parsed) {
    const message = asMessage(item);
    if (message) clean.push(message);
  }
  return trimHistory(clean);
}
