/**
 * R-048: the rank comparison for a change that WEAKENS a rule. Weakening needs a
 * rank strictly above the rule's current level; everything else keeps the
 * at-or-above rule. Mocked at the driver: the decision is about one stored row
 * and one incoming change, and the fallbacks for an unknown or NULL
 * approver_role cannot be planted through any route.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(), unsafe: vi.fn((s: string) => s),
  });
  return { sql: sqlMock, withTransaction: vi.fn(), withSavepoint: (_n: string, f: () => unknown) => f(), fmtDate: (d: unknown) => String(d) };
});
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({
  logAuditOrThrow: vi.fn().mockResolvedValue(undefined),
}));

import { sql } from '@/lib/neon';
import {
  assertMayEditRule, ApprovalRuleAuthorityError, type RuleActor, type RuleChange,
} from '@/modules/accounting/services/gl/approvalRuleGuards';

const sqlMock = sql as unknown as MockedFunction<() => Promise<unknown[]>>;
const COMPANY = 'company-1';
const RULE = 'rule-1';
const actor = (role: string): RuleActor => ({ userId: 'user-1', role, email: 'u@test.local' });

const stored = (over: Record<string, unknown> = {}) => {
  sqlMock.mockReset();
  sqlMock.mockResolvedValueOnce([{
    id: RULE, name: 'a rule', approver_role: 'admin', is_active: true,
    condition_operator: 'greater_than', condition_value: '1000', ...over,
  }]);
};

const edit = (role: string, change: RuleChange) => assertMayEditRule(COMPANY, RULE, actor(role), change);

beforeEach(() => { sqlMock.mockReset(); });

describe('who may weaken', () => {
  it('refuses the admin lowering an admin-level rule, and says a higher role is needed', async () => {
    stored();
    await expect(edit('admin', { approverRole: 'manager' })).rejects.toBeInstanceOf(ApprovalRuleAuthorityError);
    stored();
    await expect(edit('admin', { approverRole: 'manager' })).rejects.toThrow(/role above admin/);
  });

  it('lets the owner lower it', async () => {
    stored();
    await expect(edit('owner', { approverRole: 'manager' })).resolves.toMatchObject({ id: RULE });
  });

  it('lets the admin lower a manager-level rule, and refuses the manager', async () => {
    stored({ approver_role: 'manager' });
    await expect(edit('admin', { approverRole: 'accountant' })).resolves.toMatchObject({ id: RULE });
    stored({ approver_role: 'manager' });
    await expect(edit('manager', { approverRole: 'accountant' })).rejects.toBeInstanceOf(ApprovalRuleAuthorityError);
  });

  it('ranks an unknown or NULL stored role as admin: the owner may weaken it, the admin may not', async () => {
    for (const role of ['Owner', null]) {
      stored({ approver_role: role });
      await expect(edit('admin', { isActive: false })).rejects.toBeInstanceOf(ApprovalRuleAuthorityError);
      stored({ approver_role: role });
      await expect(edit('owner', { isActive: false })).resolves.toMatchObject({ id: RULE });
    }
  });
});

describe('what counts as weakening', () => {
  const weakens: [string, Record<string, unknown>, RuleChange][] = [
    ['a lower role', {}, { approverRole: 'viewer' }],
    ['deactivation', {}, { isActive: false }],
    ['a delete', {}, 'delete'],
    ['a higher greater_than threshold', {}, { conditionValue: 1001 }],
    ['a higher greater_equal threshold', { condition_operator: 'greater_equal' }, { conditionValue: 2000 }],
    ['any narrowed to a threshold', { condition_operator: 'any' }, { conditionOperator: 'greater_equal', conditionValue: 0 }],
    ['greater_equal narrowed to greater_than at the same value', { condition_operator: 'greater_equal' }, { conditionOperator: 'greater_than' }],
    ['greater_equal narrowed to greater_than above the old value', { condition_operator: 'greater_equal' }, { conditionOperator: 'greater_than', conditionValue: 1500 }],
    ['greater_than to greater_equal ABOVE the old value', {}, { conditionOperator: 'greater_equal', conditionValue: 1500 }],
    // An operator checkApproval cannot read fails closed and matches everything,
    // so it is as wide as 'any' and any real threshold narrows it.
    ['an unreadable legacy operator given a threshold', { condition_operator: 'less_than' }, { conditionOperator: 'greater_than' }],
  ];

  it.each(weakens)('%s needs a rank above the rule', async (_label, row, change) => {
    stored(row);
    await expect(edit('admin', change)).rejects.toBeInstanceOf(ApprovalRuleAuthorityError);
  });

  const neutral: [string, Record<string, unknown>, RuleChange][] = [
    ['no change at all', {}, {}],
    ['the same role restated', {}, { approverRole: 'admin' }],
    ['activation', { is_active: false }, { isActive: true }],
    ['a lower threshold', {}, { conditionValue: 999 }],
    ['greater_than widened to greater_equal at the same value', {}, { conditionOperator: 'greater_equal' }],
    ['greater_equal to greater_than just below the old value', { condition_operator: 'greater_equal' }, { conditionOperator: 'greater_than', conditionValue: 999 }],
    ['widening to any', {}, { conditionOperator: 'any' }],
    ['the unused value of an any rule', { condition_operator: 'any' }, { conditionValue: 1e9 }],
  ];

  it.each(neutral)('%s is allowed at the rule\'s own rank', async (_label, row, change) => {
    stored(row);
    await expect(edit('admin', change)).resolves.toMatchObject({ id: RULE });
  });

  it('still refuses a rank below the rule for a change that weakens nothing', async () => {
    stored();
    await expect(edit('manager', { name: 'renamed' } as RuleChange)).rejects.toBeInstanceOf(ApprovalRuleAuthorityError);
  });
});

