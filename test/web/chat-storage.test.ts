import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from '../../web/src/agent.js';
import { MAX_MESSAGES, decodeHistory, encodeHistory, trimHistory } from '../../web/src/chat-storage.js';

const user = (text: string): ChatMessage => ({ role: 'user', content: text });
const reply = (text: string): ChatMessage => ({ role: 'assistant', content: text });
const calls = (id: string): ChatMessage =>
  ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'query_pool', arguments: '{}' } }] });
const result = (id: string): ChatMessage => ({ role: 'tool', tool_call_id: id, content: '{"items":[]}' });

test('切页面回来还能看到原样的对话，包括工具调用那几轮', () => {
  const history = [user('池子里有几个币'), calls('c1'), result('c1'), reply('一共 94 个')];
  assert.deepEqual(decodeHistory(encodeHistory(history)), history);
});

test('历史过长时丢最早的几轮，保留最近的对话', () => {
  const history: ChatMessage[] = [];
  for (let i = 0; i < MAX_MESSAGES + 20; i += 1) history.push(i % 2 === 0 ? user(`问题${i}`) : reply(`回答${i}`));
  const kept = trimHistory(history);
  assert.ok(kept.length <= MAX_MESSAGES, `最多保留 ${MAX_MESSAGES} 条，实际 ${kept.length}`);
  assert.deepEqual(kept.at(-1), history.at(-1), '最后一轮必须还在');
});

test('单条消息超大时也不会把整个存储撑爆', () => {
  const kept = trimHistory([user('看一下'), calls('c1'), result('c1'), reply('x'.repeat(400_000))]);
  assert.ok(JSON.stringify(kept).length < 400_000, '超预算的历史必须被丢掉而不是原样存下');
});

test('裁剪只在用户提问处下刀，不留下没有母消息的工具结果', () => {
  const history: ChatMessage[] = [];
  for (let i = 0; i < MAX_MESSAGES + 10; i += 1) {
    history.push(user(`问题${i}`), calls(`c${i}`), result(`c${i}`), reply(`回答${i}`));
  }
  const kept = trimHistory(history);
  assert.equal(kept[0]?.role, 'user', '第一条必须是用户提问');
  const seen = new Set<string>();
  for (const message of kept) {
    if (message.role === 'assistant') for (const call of message.tool_calls ?? []) seen.add(call.id);
    if (message.role === 'tool') {
      assert.ok(seen.has(message.tool_call_id), `工具结果 ${message.tool_call_id} 找不到发起它的 assistant`);
    }
  }
});

test('没拿到结果的工具调用不会被存下来，否则下次提交会被上游拒绝', () => {
  // 用户中途点了停止：assistant 已经发起调用，tool 结果还没回来。
  const kept = trimHistory([user('诊断一下'), reply('好'), user('再查'), calls('c9')]);
  assert.deepEqual(kept, [user('诊断一下'), reply('好'), user('再查')],
    '发起调用的那条 assistant 要丢掉，用户刚打的那句留着给他看');
  assert.ok(kept.every((m) => m.role !== 'assistant' || !m.tool_calls),
    '存下来的历史里不能有任何悬空的 tool_calls');
});

test('system 提示词不进存储，重新加载时由前端重新拼', () => {
  const kept = trimHistory([{ role: 'system', content: '你是助手' }, user('在吗'), reply('在')]);
  assert.deepEqual(kept, [user('在吗'), reply('在')]);
});

test('存储里是脏数据时当作没有历史，不能让聊天页打不开', () => {
  assert.deepEqual(decodeHistory(''), []);
  assert.deepEqual(decodeHistory('{不是 json'), []);
  assert.deepEqual(decodeHistory('{"role":"user"}'), [], '不是数组就丢弃');
  assert.deepEqual(decodeHistory('[{"role":"hacker","content":"x"}]'), [], '未知角色丢弃');
  assert.deepEqual(decodeHistory('[{"role":"user"},null,3]'), [], '缺字段的条目丢弃');
});

test('空历史编码成空串，好让调用方把这条存储直接删掉', () => {
  assert.equal(encodeHistory([]), '');
});
