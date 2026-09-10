/** Branch coverage for the preview-only approval helpers; the kernel answer is the seam. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const kernel = vi.hoisted(() => ({ preview: vi.fn(), amount: vi.fn(), states: vi.fn() }));
vi.mock('@/modules/accounting/services/controls/approvalExecutionService', () => ({
  controlledOperationApprovalRequiredForPreview: kernel.preview,
  controlledOperationApprovalRequiredForAmount: kernel.amount,
}));
vi.mock('@/modules/accounting/services/controls/context', () => ({
  requireControlTx: () => ({ principal: { companyId: 'company' } }),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({
  findBankTransactionAllocationStates: kernel.states,
}));
import { partitionApprovalBound, APPROVAL_REQUIRED_REASON, APPROVAL_UNKNOWN_REASON } from '@/lib/mcp/tools/bulkApprovePreviewApproval';
import { payrollPreviewRefusal, PAYROLL_APPROVAL_REQUIRED_TEXT, PAYROLL_PREVIEW_UNAVAILABLE_TEXT } from '@/lib/mcp/tools/payrollPreviewApproval';
import { partitionBankApprovalBound } from '@/lib/mcp/tools/bankPreviewApproval';

const ref = { entityType: 'supplier_invoice', operation: 'supplier_invoice.post' as const };
const doc = { index: 0, id: 'doc' };
beforeEach(() => { vi.clearAllMocks(); });

describe('partitionApprovalBound', () => {
  it('skips an approval-bound document with the approval reason', async () => {
    kernel.preview.mockResolvedValue({ kind: 'answered', required: true });
    expect(await partitionApprovalBound([doc], ref)).toEqual({ postable: [], skipped: [{ index: 0, document_id: 'doc', reason: APPROVAL_REQUIRED_REASON }] });
  });
  it('skips an unmaterialisable document under a policy WITHOUT blaming an approval', async () => {
    kernel.preview.mockResolvedValue({ kind: 'unavailable', policiesExist: true });
    const result = await partitionApprovalBound([doc], ref);
    expect(result.skipped).toEqual([{ index: 0, document_id: 'doc', reason: APPROVAL_UNKNOWN_REASON }]);
    expect(APPROVAL_UNKNOWN_REASON).not.toMatch(/request one/i);
  });
  it('leaves an unmaterialisable document to the rest of the partition when no policy exists', async () => {
    kernel.preview.mockResolvedValue({ kind: 'unavailable', policiesExist: false });
    expect(await partitionApprovalBound([doc], ref)).toEqual({ postable: [doc], skipped: [] });
  });
});

describe('payrollPreviewRefusal', () => {
  it.each([
    [{ kind: 'answered', required: true }, PAYROLL_APPROVAL_REQUIRED_TEXT],
    [{ kind: 'answered', required: false }, null],
    [{ kind: 'unavailable', policiesExist: true }, PAYROLL_PREVIEW_UNAVAILABLE_TEXT],
    [{ kind: 'unavailable', policiesExist: false }, null],
  ])('answers %o with the matching refusal', async (answer, expected) => {
    kernel.preview.mockResolvedValue(answer);
    expect(await payrollPreviewRefusal('company', 'run')).toBe(expected);
  });
});

describe('partitionBankApprovalBound', () => {
  it('refuses to answer for a line whose bank row it cannot read, rather than assume amount 0', async () => {
    kernel.states.mockResolvedValue(new Map());
    await expect(partitionBankApprovalBound('company', [{ index: 0, txId: 'missing' }])).rejects.toThrow(/state unavailable/);
    expect(kernel.amount).not.toHaveBeenCalled();
  });
});
