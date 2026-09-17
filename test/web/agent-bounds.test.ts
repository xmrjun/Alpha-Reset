import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_TOOLS, SOCIAL_RESULT_NOTE } from '../../src/web/agent-tools.js';

const social = AGENT_TOOLS.find((tool) => tool.name === 'social_check');

test('social_check 的描述必须划清边界，否则模型会拿它编造告警因果', () => {
  assert.ok(social, '工具清单里应有 social_check');
  const text = social!.description;
  // 线上实测：模型声称「这条推写得有情绪、有立场」，而工具根本不返回任何原文。
  assert.match(text, /不返回[^。]*原文|不含[^。]*原文/, '必须声明不返回推文原文');
  // 线上实测：模型把「没告警」归因于社交热度低，但告警只看 A1~A4。
  assert.match(text, /不参与[^。]*告警|不决定[^。]*告警/, '必须声明社交面不参与告警判定');
});

test('返回字段的含义要逐个说清，mentions 尤其容易被当成发帖人', () => {
  // 线上实测：模型把 mentions 里的账号说成「你发的那条推」。
  assert.match(social!.description, /被\s*@|被提到的账号|不是发帖人/,
    'mentions 的语义必须写明，否则模型会脑补身份');
});

test('边界说明随每次结果一起返回，模型在当下就能看到', () => {
  assert.match(SOCIAL_RESULT_NOTE, /原文/, '结果里要重申没有原文');
  assert.match(SOCIAL_RESULT_NOTE, /A1|告警/, '结果里要重申与告警判定无关');
  assert.ok(SOCIAL_RESULT_NOTE.length <= 200, '这段会跟着每次结果进上下文，不能太长');
});
