/**
 * R-035 PR6: the gate's 409 text names the document. A manual journal is
 * "Manual journal <number>" and is POSTED; every earlier type's text is pinned
 * byte for byte, so adding the type changed none of them.
 */
import { describe, expect, it } from 'vitest';
import { ApprovalRequiredError } from '@/modules/accounting/services/gl/approvalGate';
import type { DocumentType } from '@/modules/accounting/services/gl/approvalService';

const message = (documentType: DocumentType, reason: 'APPROVAL_REQUIRED' | 'APPROVAL_PENDING' | 'APPROVAL_STALE') =>
  new ApprovalRequiredError({ reason, requiredRole: 'owner', ruleName: 'R', requestId: null, documentType, documentReference: 'X-1' }).message;

describe('the approval gate refusal text', () => {
  it.each([
    ['supplier_invoice', 'Supplier invoice', 'posted'], ['customer_invoice', 'Customer invoice', 'posted'],
    ['customer_credit_note', 'Customer credit note', 'posted'], ['supplier_credit_note', 'Supplier credit note', 'posted'],
    ['supplier_payment', 'Supplier payment', 'paid'], ['payment_batch', 'Payment batch', 'paid'],
    ['manual_journal', 'Manual journal', 'posted'],
  ] as [DocumentType, string, string][])('%s', (type, label, held) => {
    expect(message(type, 'APPROVAL_REQUIRED')).toBe(`${label} X-1 needs owner approval before it can be ${held} (rule: R).`);
    expect(message(type, 'APPROVAL_PENDING')).toBe(`${label} X-1 is awaiting approval by a owner before it can be ${held} (rule: R).`);
    expect(message(type, 'APPROVAL_STALE')).toBe(`${label} X-1 changed after it was approved; submit it for approval again (rule: R).`);
  });
});
