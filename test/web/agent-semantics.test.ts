import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_TOOLS, ALERTS_RESULT_NOTE, POOL_RESULT_NOTE } from '../../src/web/agent-tools.js';

test('观察池结果要带上四个条件各自的门槛值', () => {
  // A4 早就这么做了（一并返回 minCoverage，注释写着「否则模型只能干念数字」）。
  // A1~A3 没做，模型手上只有 a2:false 和一个市值数字，想解释就只能编一个区间。
  const tool = AGENT_TOOLS.find((t) => t.name === 'query_pool');
  assert.ok(tool, '应有 query_pool');
  assert.match(tool!.description, /门槛|阈值|thresholds/, '描述要告诉模型结果里带了门槛值');
});

test('观察池结果附带说明：displayRps 不参与判定，群名不等于推荐', () => {
  // 和「把社交热度说成告警原因」是同一类错误：拿不参与判定的数字去解释判定结果。
  assert.match(POOL_RESULT_NOTE, /displayRps/, '要说明 displayRps 的性质');
  assert.match(POOL_RESULT_NOTE, /不参与|不用于/, '要说明它不参与 A4 判定');
  assert.match(POOL_RESULT_NOTE, /提到|提及/, '群名只代表提及，不代表推荐');
  assert.ok(POOL_RESULT_NOTE.length <= 260, '跟着每次结果进上下文，不能太长');
});

test('告警历史结果附带说明：事后统计不是预测，也不能当作跑赢基准的证据', () => {
  assert.match(ALERTS_RESULT_NOTE, /预测/, '必须挡住「历史胜率当预测」');
  assert.match(ALERTS_RESULT_NOTE, /建议/, '必须挡住买卖建议');
  assert.match(ALERTS_RESULT_NOTE, /对照组|基准/, 'controlSince 之前没有对照组这件事要让模型看见');
  assert.ok(ALERTS_RESULT_NOTE.length <= 260);
});
