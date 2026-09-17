import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_TOOLS, parseToolArgs, AgentToolError } from '../../src/web/agent-tools.js';

test('工具清单可直接交给模型：每个工具都有名称、描述和 JSON Schema 参数', () => {
  assert.ok(AGENT_TOOLS.length >= 4, '至少提供池子/告警/覆盖率/诊断四个工具');
  const names = AGENT_TOOLS.map((tool) => tool.name);
  assert.deepEqual([...new Set(names)], names, '工具名不得重复');
  for (const tool of AGENT_TOOLS) {
    assert.match(tool.name, /^[a-z][a-z0-9_]{2,31}$/, `${tool.name} 需为模型可用的函数名`);
    assert.ok(tool.description.length >= 10, `${tool.name} 缺少可让模型判断何时调用的描述`);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.parameters.properties, 'object');
    // 模型只能传声明过的参数；放开额外字段会让无效查询直达数据库。
    assert.equal(tool.parameters.additionalProperties, false, `${tool.name} 必须禁止未声明参数`);
  }
});

test('参数校验拒绝越界与未知取值，不把模型的幻觉直接下推到查询层', () => {
  assert.deepEqual(parseToolArgs('query_coverage', {}), {}, '无参工具接受空对象');

  const pool = parseToolArgs('query_pool', { chain: 'solana', limit: 5 });
  assert.equal(pool.chain, 'solana');
  assert.equal(pool.limit, 5);

  assert.throws(() => parseToolArgs('query_pool', { limit: 9999 }), AgentToolError, 'limit 越界必须拒绝');
  assert.throws(() => parseToolArgs('query_pool', { hit: 'maybe' }), AgentToolError, 'hit 只接受 0/1');
  assert.throws(() => parseToolArgs('query_pool', { nonsense: 1 }), AgentToolError, '未声明参数必须拒绝');
  assert.throws(() => parseToolArgs('no_such_tool', {}), AgentToolError, '未知工具必须拒绝');
});

test('参数缺省时给出安全上限，避免模型一次拉走整个库', () => {
  const pool = parseToolArgs('query_pool', {});
  assert.ok(typeof pool.limit === 'number' && pool.limit > 0 && pool.limit <= 50,
    '未指定 limit 时必须有保守默认值');
  const alerts = parseToolArgs('query_alerts', {});
  assert.ok(typeof alerts.limit === 'number' && alerts.limit > 0 && alerts.limit <= 50);
});
