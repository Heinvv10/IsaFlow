/**
 * R-032: `assertMayDecide` refuses every decision taken from an impersonation
 * session, and from a session it cannot rule out as one.
 *
 * Mocked at the driver and dispatched on the SQL text, so the guard's own query
 * and the approval read answer independently of call order: the order is part
 * of what is under test (the refusal must come before the approval row is even
 * read). The query itself is proven against Postgres in
 * tests/integration/r-032-approval-impersonation.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  session: { session_id: 'session-1' as string | null, impersonated: false },
  approvalReads: 0,
}));

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('impersonation_sessions')) return [state.session];
    if (text.includes('FROM approval_requests')) {
      state.approvalReads++;
      // A pending request raised by someone else, under an admin rule, decided by an admin.
      return [{ is_self: false, rule_id: 'rule-1', resolved_rule_id: 'rule-1', required_role: 'admin',
        approver_role: 'admin', decider_role: 'admin' }];
    }
    throw new Error(`unexpected query: ${text}`);
  }), { transaction: vi.fn(), unsafe: vi.fn((s: string) => s) });
  return { sql: sqlMock, withTransaction: vi.fn(), fmtDate: (d: unknown) => String(d) };
});

import { assertMayDecide, ApprovalDecisionError } from '@/modules/accounting/services/gl/approvalAuthority';

const decide = (decision: 'approved' | 'rejected' = 'approved') =>
  assertMayDecide('company-1', 'request-1', 'decider-1', decision);

const refusal = (decision: 'approved' | 'rejected' = 'approved') => decide(decision).then(() => null, (e: unknown) => e);

describe('assertMayDecide — impersonation sessions (R-032)', () => {
  beforeEach(() => {
    state.session = { session_id: 'session-1', impersonated: false };
    state.approvalReads = 0;
  });

  it('refuses APPROVE from an impersonation session before reading the request', async () => {
    state.session = { session_id: 'session-1', impersonated: true };
    const error = await refusal();
    expect(error).toBeInstanceOf(ApprovalDecisionError);
    expect((error as ApprovalDecisionError).code).toBe('IMPERSONATION_FORBIDDEN');
    expect((error as ApprovalDecisionError).message).toMatch(/impersonat/i);
    expect(state.approvalReads).toBe(0);
  });

  it('refuses REJECT from an impersonation session — a decision is a decision', async () => {
    state.session = { session_id: 'session-1', impersonated: true };
    await expect(decide('rejected')).rejects.toMatchObject({ code: 'IMPERSONATION_FORBIDDEN' });
    expect(state.approvalReads).toBe(0);
  });

  it('refuses when the request carries no session id at all (fails closed)', async () => {
    state.session = { session_id: null, impersonated: false };
    await expect(decide()).rejects.toMatchObject({
      code: 'IMPERSONATION_FORBIDDEN', message: expect.stringMatching(/cannot confirm/i),
    });
    expect(state.approvalReads).toBe(0);
  });

  it('lets an ordinary session through to the authority checks', async () => {
    await expect(decide()).resolves.toBeUndefined();
    expect(state.approvalReads).toBe(1);
  });
});
