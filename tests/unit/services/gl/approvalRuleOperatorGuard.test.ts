/**
 * K-043 round 3 (LOW-2): the operator allowlist used to live only in
 * `pages/api/accounting/approval-rules.ts`. Every other caller of this module —
 * a script, a future MCP tool, the `services/gl/index.ts` re-export — could
 * write an operator `checkApproval` cannot evaluate, and on a database where
 * the CHECK from 647/658 has not landed the column takes it. That matters more
 * than it used to: the switch now fails CLOSED, so an unreadable operator makes
 * the rule demand approval on every document of its type.
 *
 * These call the service DIRECTLY, never the route. The driver is mocked
 * because the assertion is that the statement is never reached at all.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(), unsafe: vi.fn((s: string) => s),
  });
  return { sql: sqlMock, withTransaction: vi.fn(), withSavepoint: (_n: string, f: () => unknown) => f() };
});
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({
  logAuditOrThrow: vi.fn().mockResolvedValue(undefined),
}));

import { sql } from '@/lib/neon';
import {
  createRule, updateRule, ApprovalOperatorInvalidError, ApprovalRoleInvalidError,
  ApprovalFieldInvalidError,
} from '@/modules/accounting/services/gl/approvalService';
import type { RuleActor } from '@/modules/accounting/services/gl/approvalRuleGuards';

const sqlMock = sql as unknown as MockedFunction<() => Promise<unknown[]>>;
const COMPANY = 'company-1';
const RULE = 'rule-1';
const actor: RuleActor = { userId: 'user-1', role: 'owner', email: 'u@test.local' };

beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
});

describe('createRule operator allowlist', () => {
  it('refuses an operator checkApproval cannot evaluate, without touching the database', async () => {
    await expect(createRule(COMPANY, {
      name: 'r', documentType: 'payment', conditionOperator: 'gt',
    }, actor)).rejects.toBeInstanceOf(ApprovalOperatorInvalidError);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('names the accepted operators in the message', async () => {
    await expect(createRule(COMPANY, {
      name: 'r', documentType: 'payment', conditionOperator: 'less_than',
    }, actor)).rejects.toThrow(/any, greater_than, greater_equal/);
  });

  it('accepts an omitted operator — the column has a default', async () => {
    sqlMock.mockResolvedValueOnce([{ id: RULE, name: 'r', approver_role: 'admin' }]);
    await expect(createRule(COMPANY, { name: 'r', documentType: 'payment' }, actor))
      .resolves.toMatchObject({ id: RULE });
  });

  // Order matters only in that both guards must run before the INSERT.
  it('still refuses a bad role, so the new guard did not displace the old one', async () => {
    await expect(createRule(COMPANY, {
      name: 'r', documentType: 'payment', approverRole: 'sysadmin',
    }, actor)).rejects.toBeInstanceOf(ApprovalRoleInvalidError);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe('updateRule operator allowlist', () => {
  it('refuses before it even reads the rule row', async () => {
    await expect(updateRule(COMPANY, RULE, { conditionOperator: 'gt' }, actor))
      .rejects.toBeInstanceOf(ApprovalOperatorInvalidError);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('leaves an update that does not mention the operator alone', async () => {
    sqlMock
      .mockResolvedValueOnce([{ id: RULE, name: 'r', approver_role: 'admin', is_active: true }])
      .mockResolvedValueOnce([{ id: RULE, name: 'r', approver_role: 'admin', is_active: false }]);
    await expect(updateRule(COMPANY, RULE, { isActive: false }, actor))
      .resolves.toMatchObject({ id: RULE });
  });
});

/**
 * K-043 round 6 (LOW-3): `condition_field` was settable, stored, and never
 * evaluated — `checkApproval` matches the resolved document amount whatever the
 * column says. That is worse than decorative, because the rules page renders
 * `${conditionField} > ${conditionValue}`: a rule authored as `vat` read as a
 * VAT threshold while it governed the total. Both accepted spellings name the
 * same number; nothing branches on which one is stored.
 */
describe('conditionField allowlist', () => {
  it('refuses a create naming a field nothing evaluates, without touching the database', async () => {
    await expect(createRule(COMPANY, {
      name: 'r', documentType: 'payment', conditionField: 'vat',
    }, actor)).rejects.toBeInstanceOf(ApprovalFieldInvalidError);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('refuses an update naming one, without touching the database', async () => {
    await expect(updateRule(COMPANY, RULE, { conditionField: 'lines' }, actor))
      .rejects.toBeInstanceOf(ApprovalFieldInvalidError);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('names the accepted fields in the message', async () => {
    await expect(createRule(COMPANY, {
      name: 'r', documentType: 'payment', conditionField: 'vat',
    }, actor)).rejects.toThrow(/conditionField must be one of: total, amount/);
  });

  it('accepts both spellings and an omitted field', async () => {
    for (const conditionField of ['total', 'amount', undefined]) {
      sqlMock.mockReset();
      sqlMock.mockResolvedValueOnce([{ id: RULE, name: 'r', approver_role: 'admin' }]);
      await expect(createRule(COMPANY, { name: 'r', documentType: 'payment', conditionField }, actor))
        .resolves.toMatchObject({ id: RULE });
    }
  });
});
