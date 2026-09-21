/**
 * cancel_supplier_invoice — the tool's own contract. The plan's refusals and
 * the cancel's ledger effect are pinned against a real database in
 * cancel-supplier-invoice.int.test.ts; this pins what only the tool decides.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn().mockResolvedValue([{ id: 'rev-1', entry_number: 'JE-9' }]) }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceCancelPlan', () => {
  class SupplierInvoiceCancelRefusal extends Error {}
  return { SupplierInvoiceCancelRefusal, planSupplierInvoiceCancel: vi.fn() };
});
vi.mock('@/modules/accounting/services/ap/supplierInvoiceWorkflowService', () => ({
  cancelSupplierInvoice: vi.fn(),
}));

import {
  SupplierInvoiceCancelRefusal, planSupplierInvoiceCancel,
} from '@/modules/accounting/services/ap/supplierInvoiceCancelPlan';
import { cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { cancelSupplierInvoiceTool } from '@/lib/mcp/tools/writeCancelSupplierInvoice';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const BILL = 'b1b1b1b1-0000-4000-8000-000000000001';
const ctx = { companyId: COMPANY, userId: 'u-1', tokenJti: 'jti' } as unknown as McpToolContext;
const KEY = { idempotency_key: 'k-1' };
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

const plan = {
  invoiceId: BILL, invoiceNumber: 'BILL-7', status: 'approved', totalAmount: 115,
  journal: {
    id: 'je-1', entryNumber: 'JE-1', reversalDate: '2026-05-01',
    lines: [
      { accountId: 'ap', accountCode: '2100', accountName: 'AP', debit: 115, credit: 0 },
      { accountId: 'ex', accountCode: '6000', accountName: 'Expense', debit: 0, credit: 115 },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(planSupplierInvoiceCancel).mockResolvedValue(plan);
  vi.mocked(cancelSupplierInvoice).mockResolvedValue({ status: 'cancelled' } as never);
});

describe('cancel_supplier_invoice', () => {
  it('refuses a missing or non-uuid invoice_id before any read', async () => {
    expect(text(await cancelSupplierInvoiceTool.handler({ ...KEY }, ctx))).toBe('invoice_id is required');
    expect((await cancelSupplierInvoiceTool.handler({ invoice_id: 'x', ...KEY }, ctx)).isError).toBe(true);
    expect(planSupplierInvoiceCancel).not.toHaveBeenCalled();
  });

  it('returns a plan refusal as a toolError and never cancels', async () => {
    vi.mocked(planSupplierInvoiceCancel).mockRejectedValue(new SupplierInvoiceCancelRefusal('has R40.00 applied'));
    const r = await cancelSupplierInvoiceTool.handler({ invoice_id: BILL, ...KEY }, ctx);
    expect(text(r)).toBe('has R40.00 applied');
    expect(cancelSupplierInvoice).not.toHaveBeenCalled();
  });

  it('rethrows a plan failure that is not a refusal', async () => {
    vi.mocked(planSupplierInvoiceCancel).mockRejectedValue(new Error('connection reset'));
    await expect(cancelSupplierInvoiceTool.handler({ invoice_id: BILL, ...KEY }, ctx)).rejects.toThrow('connection reset');
  });

  it('dry_run previews the contra and never cancels', async () => {
    const r = await cancelSupplierInvoiceTool.handler({ invoice_id: BILL, dry_run: true, ...KEY }, ctx);
    expect(cancelSupplierInvoice).not.toHaveBeenCalled();
    expect((r as { wroteNothing?: boolean }).wroteNothing).toBe(true);
    const body = JSON.parse(text(r));
    expect(body.journals[0]).toMatchObject({ date: '2026-05-01', totalDebit: 115, totalCredit: 115 });
    expect(body.effects[0]).toMatchObject({ field: 'outstanding', before: 115, after: 0 });
  });

  it('cancels as the agent, with NO catch around the write', async () => {
    const r = await cancelSupplierInvoiceTool.handler({ invoice_id: BILL, ...KEY }, ctx);
    expect(cancelSupplierInvoice).toHaveBeenCalledWith(
      COMPANY, BILL, 'u-1', expect.objectContaining({ postingAgent: 'mcp:cancel_supplier_invoice:v1' }),
    );
    expect(JSON.parse(text(r))).toMatchObject({
      status: 'cancelled', journal_reversed: true, reversal_journal_entry_id: 'rev-1',
    });

    vi.mocked(cancelSupplierInvoice).mockRejectedValue(new Error('Cannot cancel invoice with payments'));
    await expect(cancelSupplierInvoiceTool.handler({ invoice_id: BILL, ...KEY }, ctx))
      .rejects.toThrow('Cannot cancel invoice with payments');
  });
});
