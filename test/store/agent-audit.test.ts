import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../../src/store/db.js';
import { createAgentAuditStore } from '../../src/store/agent-audit.js';

const day = 24 * 60 * 60 * 1000;
const t0 = Date.parse('2026-09-17T08:00:00Z');
const dayStart = Date.parse('2026-09-17T00:00:00Z');

function store() {
  const db = openDatabase(':memory:');
  return { db, audit: createAgentAuditStore(db) };
}

test('每次工具调用都留痕，包括被拒的那些', () => {
  const { audit } = store();
  audit.settle(audit.begin({ at: t0, visitor: '1.2.3.4', tool: 'social_check', arg: 'x', cached: false }),
    'ok', 0.0001);
  audit.settle(audit.begin({ at: t0 + 1, visitor: '1.2.3.4', tool: 'social_check', arg: 'y', cached: false }),
    'budget_exhausted');
  audit.settle(audit.begin({ at: t0 + 2, visitor: '9.9.9.9', tool: 'query_pool', arg: '{}', cached: false }), 'ok');

  const rows = audit.recent(10);
  assert.equal(rows.length, 3, '被拒的调用也必须留痕，否则看不见攻击');
  assert.deepEqual(rows.map((r: { outcome: string }) => r.outcome).sort(), ['budget_exhausted', 'ok', 'ok']);
});

test('访客标识存的是不可逆摘要，库里不留访客地址', () => {
  const { audit } = store();
  audit.settle(audit.begin({ at: t0, visitor: '203.0.113.7', tool: 'query_pool', arg: '{}', cached: false }), 'ok');
  const row = audit.recent(1)[0]!;
  assert.ok(!row.visitor.includes('203.0.113.7'), '不得把原始地址写进库');
  assert.match(row.visitor, /^[0-9a-f]{16}$/, '应是定长摘要');
});

test('同一个访客两次调用摘要一致，不同访客不一致', () => {
  const { audit } = store();
  audit.settle(audit.begin({ at: t0, visitor: 'a', tool: 'query_pool', arg: '{}', cached: false }), 'ok');
  audit.settle(audit.begin({ at: t0 + 1, visitor: 'a', tool: 'query_pool', arg: '{}', cached: false }), 'ok');
  audit.settle(audit.begin({ at: t0 + 2, visitor: 'b', tool: 'query_pool', arg: '{}', cached: false }), 'ok');
  const [third, second, first] = audit.recent(3);
  assert.equal(first!.visitor, second!.visitor, '同一访客必须可归因');
  assert.notEqual(third!.visitor, first!.visitor);
});

test('配额从库里算：成功与在途都占额度，失败和缓存命中不占', () => {
  const { audit } = store();
  audit.settle(audit.begin({ at: t0, visitor: 'v', tool: 'social_check', arg: '1', cached: false }), 'ok', 0.0001);
  audit.settle(audit.begin({ at: t0, visitor: 'v', tool: 'social_check', arg: '2', cached: false }), 'upstream_failed');
  audit.settle(audit.begin({ at: t0, visitor: 'v', tool: 'social_check', arg: '3', cached: true }), 'ok');
  audit.begin({ at: t0, visitor: 'v', tool: 'social_check', arg: '4', cached: false }); // 在途，未结算

  assert.equal(audit.usedToday('social_check', dayStart), 2, '一次成功 + 一次在途');
  assert.equal(audit.usedByVisitor('social_check', 'v', dayStart), 2);
});

test('跨日不计入今天的额度', () => {
  const { audit } = store();
  audit.settle(audit.begin({ at: t0 - day, visitor: 'v', tool: 'social_check', arg: '1', cached: false }), 'ok');
  assert.equal(audit.usedToday('social_check', dayStart), 0);
});

test('重开一个 store 实例，已用额度仍然算数（重启不清零）', () => {
  const db = openDatabase(':memory:');
  const first = createAgentAuditStore(db);
  first.settle(first.begin({ at: t0, visitor: 'v', tool: 'social_check', arg: '1', cached: false }), 'ok');

  const second = createAgentAuditStore(db);
  assert.equal(second.usedToday('social_check', dayStart), 1,
    '配额在进程内存里的话，把进程打崩就能重置当天额度');
  assert.equal(second.usedByVisitor('social_check', 'v', dayStart), 1, '同一个访客在重启后仍可归因');
});

test('花费被记下来，可以按天汇总', () => {
  const { audit } = store();
  audit.settle(audit.begin({ at: t0, visitor: 'v', tool: 'social_check', arg: '1', cached: false }), 'ok', 0.0001);
  audit.settle(audit.begin({ at: t0, visitor: 'v', tool: 'social_check', arg: '2', cached: false }), 'ok', 0.0002);
  assert.ok(Math.abs(audit.spentSince(dayStart) - 0.0003) < 1e-9, '出账单时要能对得上');
});
