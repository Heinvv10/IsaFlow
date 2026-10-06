/**
 * R-035 PR4: a customer invoice the pre-read let through can still be refused
 * by the approval gate inside approveCustomerInvoice (a rule added, the invoice
 * edited, a request withdrawn between the read and the post). The gate refuses
 * under the row lock, before any write, so `bulk_finalize_invoices` must report
 * that element as an `approval_required` SKIP — not unwind the whole batch as a
 * fault, which is what an unrecognised throw does.
 */
import { describe, expect, it } from 'vitest';
import { racedReason } from '@/lib/mcp/tools/writeBulkFinalizeInvoices';
import { ApprovalRequiredError } from '@/modules/accounting/services/gl/approvalGate';
import { InvoiceNotApprovableError } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';

describe('bulk_finalize_invoices racedReason', () => {
  it('maps an approval-gate refusal to an approval_required skip carrying the reason', () => {
    const err = new ApprovalRequiredError({
      reason: 'APPROVAL_PENDING', requiredRole: 'owner', ruleName: 'Owner signs', requestId: 'req-1',
      documentType: 'customer_invoice', documentReference: 'INV-0001',
    });
    expect(racedReason(err)).toBe(
      'approval_required: Customer invoice INV-0001 is awaiting approval by a owner before it can be posted (rule: Owner signs).');
  });

  it('keeps the existing mappings, and an unrecognised failure is still a fault (null)', () => {
    expect(racedReason(new InvoiceNotApprovableError('Invoice x not found', true))).toBe('not found');
    expect(racedReason(new InvoiceNotApprovableError("Cannot approve an invoice with status 'sent'"))).toMatch(/status 'sent'/);
    expect(racedReason(new Error('connection reset'))).toBeNull();
  });
});
