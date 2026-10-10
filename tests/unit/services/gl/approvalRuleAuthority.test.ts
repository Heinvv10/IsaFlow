/**
 * K-043 round 3 (HIGH-2, LOW-2): the authority `assertMayDecide` reads is the
 * rule row, and until now anybody with DEFAULT_WRITE_ROLES could rewrite it.
 * Mocked at the driver because these are decisions about one row's contents,
 * and because the rank fallbacks — an `approver_role` the ladder does not know,
 * a `company_users.role` it does not know — are both plain TEXT with no CHECK
 * and cannot be planted through any route.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(), unsafe: vi.fn((s: string) => s),
  });
  return { sql: sqlMock, withTransaction: vi.fn(), withSavepoint: (_n: string, f: () => unknown) => f(), fmtDate: (d: unknown) => String(d) };
});

import { sql } from '@/lib/neon';
import {
  assertMayEditRule, ApprovalRuleAuthorityError, type RuleActor,
} from '@/modules/accounting/services/gl/approvalRuleGuards';

const sqlMock = sql as unknown as MockedFunction<() => Promise<unknown[]>>;

const COMPANY = 'company-1';
const RULE = 'rule-1';
const actor = (role: string): RuleActor => ({ userId: 'user-1', role, email: 'u@test.local' });

const ruleRow = (approverRole: unknown) => {
  sqlMock.mockReset();
  sqlMock.mockResolvedValueOnce([{ id: RULE, name: 'a rule', approver_role: approverRole, is_active: true }]);
};

beforeEach(() => {
  sqlMock.mockReset();
});

describe('assertMayEditRule', () => {
  it('refuses an admin editing an owner-only rule', async () => {
    ruleRow('owner');
    await expect(assertMayEditRule(COMPANY, RULE, actor('admin'), {}))
      .rejects.toBeInstanceOf(ApprovalRuleAuthorityError);
  });

  it('names the role in the refusal so the UI can say why', async () => {
    ruleRow('owner');
    await expect(assertMayEditRule(COMPANY, RULE, actor('admin'), {}))
      .rejects.toThrow(/requires the owner role/);
  });

  it('allows an equal rank for an edit that weakens nothing (R-048 covers the ones that do)', async () => {
    ruleRow('admin');
    await expect(assertMayEditRule(COMPANY, RULE, actor('admin'), {})).resolves.toMatchObject({ id: RULE });
  });

  it('allows a higher rank', async () => {
    ruleRow('manager');
    await expect(assertMayEditRule(COMPANY, RULE, actor('owner'), {})).resolves.toMatchObject({ id: RULE });
  });

  // The mirror of requiredRank's fallback: an approver_role written before
  // validation existed must not become a rule anybody can edit.
  it('treats an approver_role the ladder does not know as admin, not as rank 0', async () => {
    ruleRow('Owner');
    await expect(assertMayEditRule(COMPANY, RULE, actor('manager'), {}))
      .rejects.toBeInstanceOf(ApprovalRuleAuthorityError);
    ruleRow('Owner');
    await expect(assertMayEditRule(COMPANY, RULE, actor('admin'), {})).resolves.toMatchObject({ id: RULE });
  });

  it('treats a NULL approver_role as admin', async () => {
    ruleRow(null);
    await expect(assertMayEditRule(COMPANY, RULE, actor('manager'), {}))
      .rejects.toBeInstanceOf(ApprovalRuleAuthorityError);
  });

  // actorRank's fallback: 'toString' is a real key on a plain object, so an
  // indexing `?? 0` would not fire and the comparison would be NaN < n = false.
  it('gives an actor role the ladder does not know no authority at all', async () => {
    for (const role of ['storeman', 'toString', '']) {
      ruleRow('admin');
      await expect(assertMayEditRule(COMPANY, RULE, actor(role), {}))
        .rejects.toBeInstanceOf(ApprovalRuleAuthorityError);
    }
  });

  it('returns null — not a refusal — when the id names no rule this company owns', async () => {
    sqlMock.mockReset();
    sqlMock.mockResolvedValueOnce([]);
    await expect(assertMayEditRule(COMPANY, RULE, actor('viewer'), {})).resolves.toBeNull();
  });
});

// The audit row a rule change writes is written by the rule definers since
// migration 881 (R-035 N1b B) — its shape is pinned on real Postgres by
// tests/integration/r035-n1b-rules-audit.int.test.ts.
