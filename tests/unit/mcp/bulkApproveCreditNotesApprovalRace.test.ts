/**
 * R-035 PR3: a credit note the pre-read let through can still be refused by
 * the approval gate inside approveCreditNote (a rule added, the note edited, a
 * request withdrawn between the read and the post). The gate refuses under the
 * row lock, before any write, so `bulk_approve_credit_notes` must report that
 * element as an `approval_required` SKIP — not unwind the whole batch as a
 * fault, which is what an unrecognised throw does.
 */
import { describe, expect, it } from 'vitest';
import { racedReason } from '@/lib/mcp/tools/writeBulkApproveCreditNotes';
import { ApprovalRequiredError } from '@/modules/accounting/services/gl/approvalGate';

describe('bulk_approve_credit_notes racedReason', () => {
  it('maps an approval-gate refusal to an approval_required skip carrying the reason', () => {
    const err = new ApprovalRequiredError({
      reason: 'APPROVAL_STALE', requiredRole: 'owner', ruleName: 'Owner signs', requestId: 'req-1',
      documentType: 'supplier_credit_note', documentReference: 'CN-0001',
    });
    expect(racedReason(err)).toBe(
      'approval_required: Supplier credit note CN-0001 changed after it was approved; submit it for approval again (rule: Owner signs).');
  });

  it('still treats an unrecognised failure as a fault (null)', () => {
    expect(racedReason(new Error('connection reset'))).toBeNull();
  });
});
