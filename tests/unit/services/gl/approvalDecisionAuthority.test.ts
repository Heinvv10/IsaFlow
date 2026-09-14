/**
 * K-043 round 2 (MEDIUM-2, LOW-5, LOW-6): the two rank fallbacks in
 * approvalAuthority were the only lines in the guard nothing exercised.
 *
 * A round-2 mutation turning `deciderRank`'s fallback from 0 to 99 left all 29
 * tests green, and that mutant lets a decider with no company_users row — or one
 * carrying a role the ladder does not know — satisfy EVERY rule, owner-only
 * included. The mirror mutant on `requiredRank` (admin → 0) turns a legacy rule
 * whose approver_role was written before validation existed into a rule anybody
 * clears. `company_users.role` and `approval_rules.approver_role` are both plain
 * TEXT with no CHECK, so neither input is hypothetical.
 *
 * Mocked at the driver: these are decisions about one row's contents, and an
 * integration test cannot even produce the no-membership case because withAuth
 * needs a membership row to resolve the company in the first place.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(), unsafe: vi.fn((s: string) => s),
  });
  return { sql: sqlMock, withTransaction: vi.fn(), fmtDate: (d: unknown) => String(d) };
});

import { sql } from '@/lib/neon';
import { assertMayDecide, ApprovalDecisionError } from '@/modules/accounting/services/gl/approvalAuthority';

const sqlMock = sql as unknown as MockedFunction<() => Promise<unknown[]>>;

const COMPANY = 'company-1';
const REQUEST = 'request-1';
const DECIDER = 'decider-1';

/** One pending request, its resolved rule, and the decider's membership row. */
const row = (over: { approver_role?: unknown; decider_role?: unknown; is_self?: boolean } = {}) => {
  sqlMock.mockReset();
  sqlMock.mockResolvedValueOnce([{
    is_self: over.is_self === true,
    rule_id: 'rule-1',
    resolved_rule_id: 'rule-1',
    approver_role: 'approver_role' in over ? over.approver_role : 'admin',
    decider_role: 'decider_role' in over ? over.decider_role : 'admin',
  }]);
};

const decide = (decision: 'approved' | 'rejected' = 'approved') =>
  assertMayDecide(COMPANY, REQUEST, DECIDER, decision);

describe('assertMayDecide — decider rank fallback', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('refuses a decider with no company_users row', async () => {
    row({ decider_role: null });
    const error = await decide().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ApprovalDecisionError);
    expect((error as ApprovalDecisionError).code).toBe('APPROVER_ROLE_REQUIRED');
    expect((error as ApprovalDecisionError).message).toMatch(/no role in this company/);
  });

  it('refuses a non-member even when the rule only demands viewer', async () => {
    // viewer is rank 0 and a missing role used to rank 0 too, so `0 < 0` passed.
    row({ approver_role: 'viewer', decider_role: null });
    await expect(decide()).rejects.toMatchObject({ code: 'APPROVER_ROLE_REQUIRED' });
  });

  it('refuses a decider whose role the ladder does not know', async () => {
    row({ approver_role: 'admin', decider_role: 'gremlin' });
    await expect(decide()).rejects.toMatchObject({ code: 'APPROVER_ROLE_REQUIRED' });
  });

  it('refuses a decider role that is only an Object.prototype key', async () => {
    // APPROVER_RANK['toString'] is a function, not undefined, so a `??` fallback
    // would not fire and the NaN comparison would allow the decision.
    row({ approver_role: 'admin', decider_role: 'toString' });
    await expect(decide()).rejects.toMatchObject({ code: 'APPROVER_ROLE_REQUIRED' });
  });

  // 'bookkeeper' is assignable through the platform-admin route but was absent
  // from the ladder, so the bookkeeper ranked 0 and a bookkeeper-only rule fell
  // back to demanding admin — the person hired to do the books could approve
  // nothing, and was told the rule "requires the admin role".
  it('lets a bookkeeper clear a rule that demands bookkeeper', async () => {
    row({ approver_role: 'bookkeeper', decider_role: 'bookkeeper' });
    await expect(decide()).resolves.toBeUndefined();
  });

  it('still refuses a bookkeeper on an accountant rule', async () => {
    row({ approver_role: 'accountant', decider_role: 'bookkeeper' });
    await expect(decide()).rejects.toMatchObject({ code: 'APPROVER_ROLE_REQUIRED' });
  });
});

describe('assertMayDecide — rule rank fallback', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("treats a legacy approver_role the ladder cannot read as 'admin', not as no requirement", async () => {
    row({ approver_role: 'Owner', decider_role: 'accountant' });
    await expect(decide()).rejects.toMatchObject({ code: 'APPROVER_ROLE_REQUIRED' });
  });

  it('lets an admin clear that same unreadable rule', async () => {
    row({ approver_role: 'Owner', decider_role: 'admin' });
    await expect(decide()).resolves.toBeUndefined();
  });

  it('applies the same admin floor to an Object.prototype key in approver_role', async () => {
    row({ approver_role: 'toString', decider_role: 'manager' });
    await expect(decide()).rejects.toMatchObject({ code: 'APPROVER_ROLE_REQUIRED' });
  });

  it('still refuses a manager on a genuine owner-only rule', async () => {
    row({ approver_role: 'owner', decider_role: 'manager' });
    await expect(decide()).rejects.toMatchObject({ code: 'APPROVER_ROLE_REQUIRED' });
  });
});

/**
 * Round-7 LOW-3 (R-033): with the ratchet in place a request whose snapshot rank
 * only the requester holds could be neither approved (self) nor rejected (rank)
 * by anybody, and there is no cancel action. Only APPROVE is the controlled act,
 * so the requester's own REJECT is a withdrawal and is allowed — without a rank
 * check, which is what makes it an escape for a requester below their own
 * request's demand.
 */
describe('assertMayDecide — the requester may withdraw, never approve', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('refuses the requester their own approve', async () => {
    row({ is_self: true, approver_role: 'owner', decider_role: 'owner' });
    await expect(decide('approved')).rejects.toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });
  });

  it('allows the requester their own reject', async () => {
    row({ is_self: true, approver_role: 'owner', decider_role: 'owner' });
    await expect(decide('rejected')).resolves.toBeUndefined();
  });

  it('allows the requester their own reject even when they rank below the demand', async () => {
    row({ is_self: true, approver_role: 'owner', decider_role: 'accountant' });
    await expect(decide('rejected')).resolves.toBeUndefined();
  });

  it('still refuses a NON-requester who ranks below the demand, reject included', async () => {
    row({ approver_role: 'owner', decider_role: 'manager' });
    await expect(decide('rejected')).rejects.toMatchObject({ code: 'APPROVER_ROLE_REQUIRED' });
  });

  it('still refuses a requester with no membership row their own approve', async () => {
    // Self is checked before the membership floor, and stays so: the answer
    // must name the segregation breach, not the missing role.
    row({ is_self: true, decider_role: null });
    await expect(decide('approved')).rejects.toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });
  });
});
