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

  it('folds a sub-cent NEGATIVE residual on a R0 last item into the largest line', () => {
    // Gross storage (line totals sum to totalAmount 20.00): each R10 line scales
    // to 10 × 17.41/20 = 8.705 → 8.71, overshooting net 17.41 by R0.01. The R0
    // last item was handed that as a −0.01 debit, which the validator refuses.
    // It is rounding, so it folds into the largest line (ties → the later one).
    const inv = invoice([item(10), item(10), item(0)], 17.41, 2.59);

    const lines = buildExpenseLines(inv, DEFAULT_EXPENSE);

    expect(lines.map((l) => l.debit)).toEqual([8.71, 8.7]);
    expect(validateJournalEntry(fullJournal(inv)).valid).toBe(true);
  });

  /**
   * Adversarial review HIGH: the AI capture pipeline writes an unread line
   * price as 0 and the header subtotal from the document total. The last item
   * has always carried the residual — here the whole R1,000 — so dropping R0
   * items BEFORE allocation left no expense line and an unbalanced journal on a
   * bill that used to post.
   */
  it('keeps a single R0 item that carries the whole subtotal as its residual', () => {
    const inv = invoice([item(0, { glAccountId: 'gl-exp-b' })], 1000, 150);

    const lines = buildExpenseLines(inv, DEFAULT_EXPENSE);

    expect(lines).toEqual([expect.objectContaining({ glAccountId: 'gl-exp-b', debit: 1000 })]);
    expect(validateJournalEntry(fullJournal(inv)).valid).toBe(true);
  });

  /** Adversarial review MEDIUM: the residual must stay on the account and
   *  project it always landed on, not move to another line. */
  it('leaves a real residual on the R0 last item\'s own account and project', () => {
    const inv = invoice([
      item(500, { glAccountId: 'gl-exp-a', projectId: 'p1' }),
      item(0, { glAccountId: 'gl-exp-b', projectId: 'p2' }),
    ], 1000);

    const lines = buildExpenseLines(inv, DEFAULT_EXPENSE);

    expect(lines).toEqual([
      expect.objectContaining({ glAccountId: 'gl-exp-a', projectId: 'p1', debit: 500 }),
      expect.objectContaining({ glAccountId: 'gl-exp-b', projectId: 'p2', debit: 500 }),
    ]);
  });

  /** Adversarial review LOW: a tiny last item can round to R0.00 exactly. */
  it('drops a last line that rounds to exactly R0.00', () => {
    const inv = invoice([item(100), item(0.01)], 100);

    expect(buildExpenseLines(inv, DEFAULT_EXPENSE).map((l) => l.debit)).toEqual([100]);
    expect(validateJournalEntry(fullJournal(inv)).valid).toBe(true);
  });

  /**
   * Re-review MEDIUM: a line-count tolerance cannot tell rounding from a real
   * negative item. 199 × R10 on A plus a −R1.50 discount on its own account and
   * project fell inside 200 × 1c, and folding it merged the discount into an A
   * line — the discount account and project never posted. Only a SCALED (gross)
   * allocation rounds, and only when the last item is not itself negative.
   */
  it('never folds a genuinely negative last item into another line', () => {
    const items = [
      ...Array.from({ length: 199 }, () => item(10, { glAccountId: 'gl-exp-a' })),
      item(-1.5, { glAccountId: 'gl-discount', projectId: 'px' }),
    ];
    const inv = invoice(items, 1988.5);

    const lines = buildExpenseLines(inv, DEFAULT_EXPENSE);

    expect(lines[lines.length - 1]).toEqual(
      expect.objectContaining({ glAccountId: 'gl-discount', projectId: 'px', debit: -1.5 }),
    );
    expect(lines.filter((l) => l.glAccountId === 'gl-exp-a').every((l) => l.debit === 10)).toBe(true);
    expect(validateJournalEntry(fullJournal(inv)).valid).toBe(false);
  });

  it('never folds in NET storage — line totals are whole cents, so a negative residual is bad data', () => {
    // Items [0.02 A, 0.01 B, R0 C] against subtotal 0.01: folding took A to 0.00
    // and dropped it although A has the larger line total.
    const inv = invoice([
      item(0.02, { glAccountId: 'gl-a' }), item(0.01, { glAccountId: 'gl-b' }), item(0, { glAccountId: 'gl-c' }),
    ], 0.01);

    const lines = buildExpenseLines(inv, DEFAULT_EXPENSE);

    expect(lines.map((l) => [l.glAccountId, l.debit])).toEqual([['gl-a', 0.02], ['gl-b', 0.01], ['gl-c', -0.02]]);
    expect(validateJournalEntry(fullJournal(inv)).valid).toBe(false);
  });

  it('does NOT fold a negative residual larger than rounding — that is bad data, left to refuse', () => {
    // Σ line totals 1,200 against a net subtotal of 1,000, net storage: the last
    // line comes out at −200. Moving R200 onto another line would silently
    // re-dimension real value, so the builder leaves it for the validator.
    const inv = invoice([item(600), item(600), item(0)], 1000);

    const lines = buildExpenseLines(inv, DEFAULT_EXPENSE);

    expect(lines.map((l) => l.debit)).toEqual([600, 600, -200]);
    expect(validateJournalEntry(fullJournal(inv)).valid).toBe(false);
  });

  it('leaves a bill with no zero items unchanged', () => {
    const inv = invoice([item(100), item(50)], 150);

    expect(buildExpenseLines(inv, DEFAULT_EXPENSE).map((l) => l.debit)).toEqual([100, 50]);
  });
});
