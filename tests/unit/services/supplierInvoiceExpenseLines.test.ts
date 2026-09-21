/**
 * buildExpenseLines must never emit a zero-value journal line.
 *
 * A bill carrying a R0.00 item (a free-of-charge line, a zero-rated sample, a
 * Sage import's memo row) built a line with debit 0 and credit 0.
 * validateJournalLine refuses that shape, so approveSupplierInvoice threw — and
 * inside bulk_approve_supplier_invoices the throw is not a classifiable skip, so
 * ONE such bill unwound every other bill in the batch.
 *
 * Asserted through the real validateJournalEntry, not a mock: the defect was
 * the two disagreeing, and a mocked validator cannot disagree.
 */

import { describe, it, expect } from 'vitest';
import { buildExpenseLines } from '@/modules/accounting/services/ap/supplierInvoiceExpenseLines';
import { validateJournalEntry } from '@/modules/accounting/utils/doubleEntry';
import type { SupplierInvoice, SupplierInvoiceItem } from '@/modules/accounting/types/ap.types';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';

const DEFAULT_EXPENSE = 'gl-default-expense';

function item(lineTotal: number, overrides: Partial<SupplierInvoiceItem> = {}): SupplierInvoiceItem {
  return {
    id: `item-${lineTotal}-${Math.random()}`,
    supplierInvoiceId: 'si-1',
    description: `line ${lineTotal}`,
    quantity: 1,
    unitPrice: lineTotal,
    taxRate: 0,
    taxAmount: 0,
    lineTotal,
    glAccountId: 'gl-expense',
    createdAt: '2026-09-01',
    ...overrides,
  };
}

function invoice(items: SupplierInvoiceItem[], subtotal: number, taxAmount = 0): SupplierInvoice {
  return {
    id: 'si-1',
    invoiceNumber: 'BILL-1',
    supplierId: 'sup-1',
    invoiceDate: '2026-09-01',
    subtotal,
    taxRate: taxAmount > 0 ? 15 : 0,
    taxAmount,
    totalAmount: subtotal + taxAmount,
    amountPaid: 0,
    balance: subtotal + taxAmount,
    currency: 'ZAR',
    status: 'draft',
    matchStatus: 'unmatched',
    createdBy: 'u-1',
    createdAt: '2026-09-01',
    updatedAt: '2026-09-01',
    items,
  } as SupplierInvoice;
}

/** The whole journal approveSupplierInvoice would build: expense + VAT + AP. */
function fullJournal(inv: SupplierInvoice): JournalLineInput[] {
  const lines = buildExpenseLines(inv, DEFAULT_EXPENSE);
  if (inv.taxAmount > 0) lines.push({ glAccountId: 'gl-vat', debit: inv.taxAmount, credit: 0 });
  lines.push({ glAccountId: 'gl-ap', debit: 0, credit: inv.totalAmount });
  return lines;
}

describe('buildExpenseLines — zero-value items', () => {
  it('omits a zero-value item so the journal validates', () => {
    const inv = invoice([item(100), item(0), item(50)], 150);

    const lines = buildExpenseLines(inv, DEFAULT_EXPENSE);

    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.debit > 0)).toBe(true);
    expect(validateJournalEntry(fullJournal(inv)).valid).toBe(true);
  });

  it('omits a zero-value LAST item without losing the rounding residual', () => {
    // The last line absorbs the residual. When the last item is R0 and there is
    // no residual, it must be dropped — not posted as a 0/0 line.
    const inv = invoice([item(100), item(50), item(0)], 150);

    const lines = buildExpenseLines(inv, DEFAULT_EXPENSE);

    expect(lines.map((l) => l.debit)).toEqual([100, 50]);
    expect(validateJournalEntry(fullJournal(inv)).valid).toBe(true);
  });

  it('puts the rounding residual on the last NON-zero line when the last item is R0', () => {
    // Gross storage (line totals sum to totalAmount 20.00): each R10 line scales
    // to 10 × 17.41/20 = 8.705 → 8.71, overshooting net 17.41 by R0.01. Before
    // the fix the R0 last item absorbed it as a −0.01 debit, which the
    // validator also refuses. It must land on the second R10 line instead.
    const inv = invoice([item(10), item(10), item(0)], 17.41, 2.59);

    const lines = buildExpenseLines(inv, DEFAULT_EXPENSE);

    expect(lines.map((l) => l.debit)).toEqual([8.71, 8.7]);
    expect(validateJournalEntry(fullJournal(inv)).valid).toBe(true);
  });

  it('leaves a bill with no zero items unchanged', () => {
    const inv = invoice([item(100), item(50)], 150);

    expect(buildExpenseLines(inv, DEFAULT_EXPENSE).map((l) => l.debit)).toEqual([100, 50]);
  });
});
