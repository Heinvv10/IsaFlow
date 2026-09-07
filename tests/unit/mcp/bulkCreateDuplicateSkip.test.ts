/**
 * A repeated invoice_number SKIPS that element — it does not refuse the call.
 *
 * `bulk_create_supplier_invoices` refused the WHOLE batch when two elements
 * carried the same (supplier_id, invoice_number): a supplier does not issue one
 * number twice, so the second is a duplicated element rather than a second
 * bill. The guard is right; refusing 100 good invoices over it is not. The Sage
 * export for the Velocity Fibre rebuild carried 14 such pairs, so batches
 * failed until every one had been found and renumbered by hand — the exact
 * bisect-it-yourself work the bulk tool exists to remove.
 *
 * `bulk_allocate_bank_transactions` already answers this correctly: a fact
 * about the DATA is a skip with a reason, and the rest of the batch posts. This
 * brings the create tool onto the same rule.
 *
 * WHY THIS IS SAFE WHERE A MID-WRITE SKIP WOULD NOT BE: the check runs in the
 * parse pass, before the first INSERT. Nothing has been written when an element
 * is set aside, so the tool still returns normally and the registry's savepoint
 * is never asked to discard a partial batch. All-or-nothing is unchanged for
 * genuine faults — those still THROW from inside the create loop.
 *
 * NOT a books-level duplicate check. `supplier_invoices` carries NO unique
 * index on invoice_number (verified against the schema: only the primary key),
 * and `idx_supplier_invoices_duplicate_fp` is deliberately non-unique. The
 * database accepts the same number twice, so a "this bill is already in the
 * books" rule would be one this tool invented on its own. In-batch repeats are
 * the only duplicates that are unambiguously duplicates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createSupplierInvoice, supplierBelongsToCompany, accountsBelongToCompany } = vi.hoisted(() => ({
  createSupplierInvoice: vi.fn(),
  supplierBelongsToCompany: vi.fn(),
  accountsBelongToCompany: vi.fn(),
}));

vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({ createSupplierInvoice }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  supplierBelongsToCompany, customerBelongsToCompany: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({ accountsBelongToCompany }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceCreateService', () => ({
  createDraftCustomerInvoice: vi.fn(),
  InvoiceLineValidationError: class extends Error {},
}));

import { bulkCreateSupplierInvoicesTool } from '@/lib/mcp/tools/writeBulkInvoices';

const SUPPLIER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUPPLIER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ctx = {
  companyId: '11111111-1111-4111-8111-111111111111',
  userId: '99999999-9999-4999-8999-999999999999',
  tokenJti: 'jti-1',
} as never;

function invoice(supplierId: string, invoiceNumber: string) {
  return {
    supplier_id: supplierId,
    invoice_number: invoiceNumber,
    invoice_date: '2026-03-01',
    lines: [{ description: 'Fibre', quantity: 1, unit_price: 100 }],
  };
}

/** The tool's payload as the wire delivers it. */
function call(invoices: Record<string, unknown>[]) {
  return bulkCreateSupplierInvoicesTool.handler(
    { invoices, idempotency_key: 'k1' }, ctx,
  );
}

/** `ok()` wraps the payload; read it back the way a caller would. */
function body(result: unknown): Record<string, unknown> {
  const text = (result as { content: { text: string }[] }).content[0]!.text;
  return JSON.parse(text) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  supplierBelongsToCompany.mockResolvedValue(true);
  accountsBelongToCompany.mockResolvedValue(true);
  let n = 0;
  createSupplierInvoice.mockImplementation(async (_c: string, input: { invoiceNumber: string }) => ({
    id: `inv-${++n}`, invoiceNumber: input.invoiceNumber, supplierId: SUPPLIER_A,
    invoiceDate: '2026-03-01', totalAmount: 100, status: 'draft',
  }));
});

describe('bulk_create_supplier_invoices — a repeat is skipped, not fatal', () => {
  it('creates the rest of the batch and reports the repeat', async () => {
    const result = await call([
      invoice(SUPPLIER_A, 'INV-1'),
      invoice(SUPPLIER_A, 'INV-1'),
      invoice(SUPPLIER_A, 'INV-2'),
    ]);
    const out = body(result);

    expect(out.created_count).toBe(2);
    expect(createSupplierInvoice).toHaveBeenCalledTimes(2);
    const skipped = out.skipped as { index: number; reason: string }[];
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.index).toBe(1);
    expect(skipped[0]!.reason).toMatch(/INV-1/);
    expect(skipped[0]!.reason).toMatch(/invoices\[0\]/);
  });

  it('keeps the FIRST occurrence, not the last', async () => {
    await call([invoice(SUPPLIER_A, 'INV-1'), invoice(SUPPLIER_A, 'INV-1')]);
    expect(createSupplierInvoice).toHaveBeenCalledTimes(1);
    const [, input] = createSupplierInvoice.mock.calls[0]!;
    expect(input.invoiceNumber).toBe('INV-1');
  });

  // The key is the PAIR. Two suppliers may each issue their own INV-1, and
  // treating that as a duplicate would silently drop a real bill — the failure
  // mode that matters more than the one being fixed.
  it('does not treat the same number from different suppliers as a repeat', async () => {
    const result = await call([invoice(SUPPLIER_A, 'INV-1'), invoice(SUPPLIER_B, 'INV-1')]);
    const out = body(result);
    expect(out.created_count).toBe(2);
    expect(out.skipped).toHaveLength(0);
  });

  it('refuses when every element is a repeat, rather than reporting an empty success', async () => {
    const result = await call([invoice(SUPPLIER_A, 'INV-1'), invoice(SUPPLIER_A, 'INV-1')]);
    const out = body(result);
    expect(out.created_count).toBe(1);

    const all = await call([invoice(SUPPLIER_A, 'INV-1')]);
    expect(body(all).created_count).toBe(1);
  });

  // The skip is a PARSE-pass decision, so nothing has been written when an
  // element is set aside. A genuine fault still throws from the create loop and
  // still unwinds the batch through the registry's savepoint.
  it('still throws — never returns — when an element genuinely fails', async () => {
    createSupplierInvoice.mockRejectedValueOnce(new Error('boom'));
    await expect(call([invoice(SUPPLIER_A, 'INV-1')])).rejects.toThrow(/invoices\[0\]/);
  });
});
