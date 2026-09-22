/**
 * unapply_supplier_payment / unapply_credit_note — the tools' own contract.
 * The ledger effect and every refusal are pinned against a real database in
 * tests/integration/unapply.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/ap/supplierPaymentUnapply', () => {
  class UnapplyRefusal extends Error {}
  return { UnapplyRefusal, planSupplierPaymentUnapply: vi.fn(), unapplySupplierPayment: vi.fn() };
});
vi.mock('@/modules/accounting/services/shared/creditNoteUnapply', () => ({
  planCreditNoteUnapply: vi.fn(), unapplyCreditNote: vi.fn(),
}));

import {
  UnapplyRefusal, planSupplierPaymentUnapply, unapplySupplierPayment,
} from '@/modules/accounting/services/ap/supplierPaymentUnapply';
import { planCreditNoteUnapply, unapplyCreditNote } from '@/modules/accounting/services/shared/creditNoteUnapply';
import { unapplyCreditNoteTool, unapplySupplierPaymentTool } from '@/lib/mcp/tools/writeUnapply';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const PAY = '0d0d0d0d-0000-4000-8000-000000000001';
const NOTE = '0e0e0e0e-0000-4000-8000-000000000001';
const BILL = '0f0f0f0f-0000-4000-8000-000000000001';
const ctx = { companyId: COMPANY, userId: 'u-1' } as McpToolContext;
const KEY = { idempotency_key: 'k-1' };
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const line = { invoiceId: BILL, invoiceNumber: 'B-1', amount: 40, outstandingBefore: 0, outstandingAfter: 40 };
const payPlan = {
  paymentId: PAY, paymentNumber: 'PAY-1', amountUnapplied: 40, lines: [line],
  paymentStatusAfter: 'processed', unappliedAfter: 40,
};
const notePlan = {
  creditNoteId: NOTE, creditNoteNumber: 'CN-1', side: 'customer' as const, amountUnapplied: 40,
  lines: [line], noteAppliedAfter: 60, noteStatusAfter: 'partially_applied',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(planSupplierPaymentUnapply).mockResolvedValue(payPlan);
  vi.mocked(unapplySupplierPayment).mockResolvedValue(payPlan);
  vi.mocked(planCreditNoteUnapply).mockResolvedValue(notePlan);
  vi.mocked(unapplyCreditNote).mockResolvedValue(notePlan);
});

describe('unapply_supplier_payment', () => {
  it('refuses a missing or non-uuid id before any read', async () => {
    expect(text(await unapplySupplierPaymentTool.handler({ ...KEY }, ctx))).toBe('payment_id is required');
    expect((await unapplySupplierPaymentTool.handler({ payment_id: PAY, invoice_id: 'x', ...KEY }, ctx)).isError).toBe(true);
    expect(planSupplierPaymentUnapply).not.toHaveBeenCalled();
    expect(unapplySupplierPayment).not.toHaveBeenCalled();
  });

  it('dry_run plans and never writes', async () => {
    const r = await unapplySupplierPaymentTool.handler({ payment_id: PAY, dry_run: true, ...KEY }, ctx);
    expect(unapplySupplierPayment).not.toHaveBeenCalled();
    expect((r as { wroteNothing?: boolean }).wroteNothing).toBe(true);
    expect(JSON.parse(text(r)).effects[0]).toMatchObject({ field: 'outstanding', before: 0, after: 40 });
  });

  it('passes the named bill through and reports no journal', async () => {
    const r = await unapplySupplierPaymentTool.handler({ payment_id: PAY, invoice_id: BILL, ...KEY }, ctx);
    expect(unapplySupplierPayment).toHaveBeenCalledWith(COMPANY, { paymentId: PAY, invoiceId: BILL }, 'u-1');
    expect(JSON.parse(text(r))).toMatchObject({ journal_posted: false, amount_unapplied: 40, payment_status: 'processed' });
  });

  it('returns a refusal as a toolError, and rethrows anything else', async () => {
    vi.mocked(unapplySupplierPayment).mockRejectedValueOnce(new UnapplyRefusal('belongs to batch'));
    expect(text(await unapplySupplierPaymentTool.handler({ payment_id: PAY, ...KEY }, ctx))).toBe('belongs to batch');
    vi.mocked(unapplySupplierPayment).mockRejectedValueOnce(new Error('deadlock'));
    await expect(unapplySupplierPaymentTool.handler({ payment_id: PAY, ...KEY }, ctx)).rejects.toThrow('deadlock');
  });
});

describe('unapply_credit_note', () => {
  it('dry_run plans against the note\'s own side and never writes', async () => {
    const r = await unapplyCreditNoteTool.handler({ credit_note_id: NOTE, dry_run: true, ...KEY }, ctx);
    expect(unapplyCreditNote).not.toHaveBeenCalled();
    expect(JSON.parse(text(r)).effects[0]).toMatchObject({ entityType: 'customer_invoice' });
  });

  it('returns a refusal as a toolError, and rethrows anything else', async () => {
    vi.mocked(unapplyCreditNote).mockRejectedValueOnce(new UnapplyRefusal('is cancelled'));
    expect(text(await unapplyCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx))).toBe('is cancelled');
    vi.mocked(unapplyCreditNote).mockRejectedValueOnce(new Error('connection reset'));
    await expect(unapplyCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx)).rejects.toThrow('connection reset');
  });
});
