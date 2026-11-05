/** Which approval is "the" decision on a run: the one the gate cleared (its digest is the run's approved plan hash). */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
const approved = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/modules/accounting/services/gl/approvalGate', () => ({ approvedRequestsFor: approved }));

import { describePayRunDecision, readPayRunDecision } from '@/modules/accounting/services/payroll/payRunDecision';

const req = (id: string, digest: string | null, requestedBy: string, decidedBy: string | null) =>
  ({ id, documentDigest: digest, effectiveRequiredRole: 'manager', requestedBy, decidedBy });

beforeEach(() => { sqlMock.mockReset(); approved.mockReset(); });

describe('readPayRunDecision', () => {
  it('takes the request whose digest is the plan hash, not the newest approval', async () => {
    approved.mockResolvedValue([req('stale', 'H-old', 'a', 'a'), req('cleared', 'H-now', 'a', 'b')]);
    await expect(readPayRunDecision('c', 'r', 'H-now')).resolves.toEqual({
      requestId: 'cleared', requestedBy: 'a', decidedBy: 'b', selfApprovedSoleApprover: false,
    });
  });

  it('marks the requester\'s own approval as the sole-approver fallback', async () => {
    approved.mockResolvedValue([req('mine', 'H', 'a', 'a')]);
    expect((await readPayRunDecision('c', 'r', 'H'))?.selfApprovedSoleApprover).toBe(true);
  });

  it('is null when no approval carries that hash', async () => {
    approved.mockResolvedValue([req('other', 'H-old', 'a', 'b')]);
    await expect(readPayRunDecision('c', 'r', 'H-now')).resolves.toBeNull();
  });
});

describe('describePayRunDecision', () => {
  it('reads nothing for a run that is not approved or paid', async () => {
    await expect(describePayRunDecision('c', 'r', 'calculated')).resolves.toBeNull();
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('is null for a grandfathered run (no reviewed hash, so no request)', async () => {
    sqlMock.mockResolvedValue([{ approved_plan_hash: null, prepared_by: 'p', approval_grandfathered_at: '2026-01-01' }]);
    await expect(describePayRunDecision('c', 'r', 'approved')).resolves.toBeNull();
    expect(approved).not.toHaveBeenCalled();
  });

  it('returns only the two facts, and says when the preparer also decided', async () => {
    sqlMock.mockResolvedValue([{ approved_plan_hash: 'H', prepared_by: 'b', approval_grandfathered_at: null }]);
    approved.mockResolvedValue([req('x', 'H', 'a', 'b')]);
    await expect(describePayRunDecision('c', 'r', 'approved')).resolves.toEqual({ selfApprovedSoleApprover: false, preparedByDecider: true });
  });
});
