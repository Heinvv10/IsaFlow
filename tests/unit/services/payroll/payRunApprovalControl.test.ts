import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollApprovalGate', () => ({
  judgePayrollApproval: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/approvalGate', async () => {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/gl/approvalGate')>(
    '@/modules/accounting/services/gl/approvalGate',
  );
  return { ...actual, assertApprovalClearedForDocument: vi.fn(), describeApprovalGateForDocument: vi.fn() };
});

import { sql } from '@/lib/neon';
import { judgePayrollApproval } from '@/modules/accounting/services/payroll/payrollApprovalGate';
import {
  ApprovalRequiredError,
  assertApprovalClearedForDocument,
  describeApprovalGateForDocument,
} from '@/modules/accounting/services/gl/approvalGate';
import {
  assertPayRunApproved,
  describePayRunApproval,
  preparePayRunApprovalRequest,
} from '@/modules/accounting/services/payroll/payRunApprovalControl';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const gate = { planHash: 'plan-a', blocker: null, plan: {}, posted: null, replaces: null };

describe('pay-run R-035 approval control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(judgePayrollApproval).mockResolvedValue(gate as never);
    vi.mocked(sql).mockResolvedValue([{ status: 'calculated', approval_grandfathered_at: null }] as never);
    vi.mocked(assertApprovalClearedForDocument).mockResolvedValue(undefined);
  });

  it('requires approval even for a tiny run and binds the request to the current plan hash', async () => {
    await preparePayRunApprovalRequest(COMPANY, RUN);
    expect(sql).toHaveBeenCalled();
    expect(judgePayrollApproval).toHaveBeenCalledWith(COMPANY, RUN);
  });

  it('refuses a posting path without clearance for the reviewed plan hash', async () => {
    vi.mocked(assertApprovalClearedForDocument).mockRejectedValue(new ApprovalRequiredError({
      reason: 'APPROVAL_REQUIRED', requiredRole: 'manager', ruleName: 'All pay runs',
      requestId: null, documentType: 'pay_run', documentReference: '04/2026',
    }));
    await expect(assertPayRunApproved(COMPANY, RUN, 'plan-a')).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('passes the exact reviewed hash, so a recalculated plan cannot reuse an old approval', async () => {
    vi.mocked(assertApprovalClearedForDocument).mockRejectedValue(new ApprovalRequiredError({
      reason: 'APPROVAL_STALE', requiredRole: 'manager', ruleName: 'All pay runs',
      requestId: 'request-old', documentType: 'pay_run', documentReference: '04/2026',
    }));
    await expect(assertPayRunApproved(COMPANY, RUN, 'plan-b')).rejects.toMatchObject({ reason: 'APPROVAL_STALE' });
    expect(assertApprovalClearedForDocument).toHaveBeenCalledWith(
      COMPANY, 'pay_run', RUN, expect.objectContaining({ digest: 'plan-b' }),
    );
  });

  it.each(['approved', 'paid'])('grandfathers a historical %s run without retroactive approval', async (status) => {
    vi.mocked(sql).mockResolvedValue([{ status, approval_grandfathered_at: '2026-10-31T00:00:00Z' }] as never);
    await expect(assertPayRunApproved(COMPANY, RUN)).resolves.toMatchObject({ grandfathered: true });
    expect(assertApprovalClearedForDocument).not.toHaveBeenCalled();
  });

  it('describes the approval against the live plan hash without mutating the run', async () => {
    vi.mocked(describeApprovalGateForDocument).mockResolvedValue({
      state: 'required', enforced: true, requiredRole: 'manager', ruleName: 'All pay runs', requestId: null,
    });
    const state = await describePayRunApproval(COMPANY, RUN);
    expect(state.state).toBe('required');
    expect(describeApprovalGateForDocument).toHaveBeenCalledWith(
      COMPANY, 'pay_run', RUN, expect.objectContaining({ digest: 'plan-a' }),
    );
  });
});
