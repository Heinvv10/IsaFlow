/**
 * Dimensions Phase 1 — documents carry CC1/CC2/BU onto their GL lines.
 *
 * Bills: each item's dimensions ride on its EXPENSE leg; the AP and VAT legs
 * the workflow adds carry none. Customer invoices: one revenue line per
 * distinct (account, job, CC1, CC2, BU) — ar/invoiceRevenueLines since
 * migration 874 — summing exactly to the subtotal; the FNO defaults from the
 * customer and a conflicting one is refused; with no dimension anywhere the
 * journal is the single revenue line it always was.
 */
import { describe, expect, it } from 'vitest';
import { buildExpenseLines } from '@/modules/accounting/services/ap/supplierInvoiceExpenseLines';
import { buildInvoiceRevenueLines, type StoredRevenueLine } from '@/modules/accounting/services/ar/invoiceRevenueLines';
import { InvoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCoding';
import { validateJournalEntry } from '@/modules/accounting/utils/doubleEntry';
import type { SupplierInvoice, SupplierInvoiceItem } from '@/modules/accounting/types/ap.types';

function item(lineTotal: number, overrides: Partial<SupplierInvoiceItem> = {}): SupplierInvoiceItem {
  return {
    id: `item-${lineTotal}`, supplierInvoiceId: 'si-1', description: `line ${lineTotal}`, quantity: 1,
    unitPrice: lineTotal, taxRate: 15, taxAmount: 0, lineTotal, glAccountId: 'gl-cos', createdAt: '2026-09-01',
    ...overrides,
  };
}

const bill = (items: SupplierInvoiceItem[], subtotal: number): SupplierInvoice => ({
  id: 'si-1', invoiceNumber: 'BILL-1', supplierId: 'sup-1', invoiceDate: '2026-09-01', subtotal, taxRate: 15,
  taxAmount: subtotal * 0.15, totalAmount: subtotal * 1.15, amountPaid: 0, balance: subtotal * 1.15,
  currency: 'ZAR', status: 'draft', matchStatus: 'unmatched', createdBy: 'u', createdAt: '', updatedAt: '', items,
} as SupplierInvoice);

describe('bill posting carries dimensions on the expense legs', () => {
  it('each item keeps its own CC1/CC2/BU; an untagged item gets none', () => {
    const lines = buildExpenseLines(bill([
      item(600, { cc1Id: 'fno-ft', cc2Id: 'lawley', buId: 'build' }),
      item(400, { buId: 'maint' }),
      item(100),
    ], 1100), 'gl-default');
    expect(lines[0]).toMatchObject({ debit: 600, cc1Id: 'fno-ft', cc2Id: 'lawley', buId: 'build' });
    expect(lines[1]).toMatchObject({ debit: 400, buId: 'maint' });
    expect(lines[1]!.cc2Id).toBeUndefined();
    expect('cc1Id' in lines[2]!).toBe(false);
  });
});

describe('customer invoice revenue legs (one builder: account, job, CC1, CC2, BU — migration 874)', () => {
  const build = (subtotal: number, lines: StoredRevenueLine[], customerFnoId: string | null) => buildInvoiceRevenueLines({
    invoiceNumber: 'INV-1', documentSubtotal: subtotal, credit: subtotal, lines, defaultRevenueAccountId: 'rev', customerFnoId,
  });
  const item = (amount: number, dims: Partial<StoredRevenueLine> = {}): StoredRevenueLine =>
    ({ amount, glAccountId: null, projectId: null, ...dims });

  it('is the SAME single revenue line as before when nothing names a dimension', () => {
    expect(build(1000, [item(600), item(400)], null))
      .toEqual([{ glAccountId: 'rev', debit: 0, credit: 1000, description: 'Revenue: INV-1' }]);
  });

  it('takes the customer FNO on revenue when the items name none', () => {
    expect(build(1000, [item(1000)], 'FNO-FT'))
      .toEqual([{ glAccountId: 'rev', debit: 0, credit: 1000, description: 'Revenue: INV-1', cc1Id: 'fno-ft' }]);
  });

  it('splits the subtotal by (CC1, CC2, BU), summing EXACTLY to it', () => {
    const lines = build(1000.01, [
      item(333.33, { cc2Id: 'lawley', buId: 'act' }),
      item(333.34, { cc2Id: 'lawley', buId: 'act' }),
      item(333.34, { cc2Id: 'mohadin', buId: 'civ' }),
    ], 'fno-ft');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ credit: 666.67, cc1Id: 'fno-ft', cc2Id: 'lawley', buId: 'act' });
    expect(lines[1]).toMatchObject({ credit: 333.34, cc1Id: 'fno-ft', cc2Id: 'mohadin', buId: 'civ' });
    expect(Math.round(lines.reduce((s, l) => s + l.credit, 0) * 100) / 100).toBe(1000.01);
    const journal = [{ glAccountId: 'ar', debit: 1150.01, credit: 0 }, ...lines, { glAccountId: 'vat', debit: 0, credit: 150 }];
    expect(validateJournalEntry(journal).valid).toBe(true);
  });

  it('REFUSES an item whose FNO differs from the customer FNO', () => {
    expect(() => build(100, [item(100, { cc1Id: 'fno-herotel' })], 'fno-ft')).toThrow(/differs from the customer's FNO/);
  });

  it('CHANGED from #663: a discount group on its own dimensions posts as its own debit leg, dims kept', () => {
    // #663 fell back to ONE line carrying only the FNO here, dropping BU 'build' and 'disc'.
    expect(build(900, [item(1000, { buId: 'build' }), item(-100, { buId: 'disc' })], 'fno-ft')).toEqual([
      expect.objectContaining({ glAccountId: 'rev', debit: 0, credit: 1000, cc1Id: 'fno-ft', buId: 'build' }),
      expect.objectContaining({ glAccountId: 'rev', debit: 100, credit: 0, cc1Id: 'fno-ft', buId: 'disc' }),
    ]);
  });

  it('CHANGED from #663: items that do not add up to the subtotal are refused, not absorbed by the last group', () => {
    // #663 put the 50.00 difference on the last group (credit 550 against items of 500).
    expect(() => build(1050, [item(500, { buId: 'a' }), item(500, { buId: 'b' })], null))
      .toThrow(InvoiceLineCodingRefusal);
  });

  it('a job and a CC2 project are separate tags: the same CC2 on two jobs is two legs', () => {
    const lines = build(100, [item(70, { projectId: 'job-1', cc2Id: 'lawley' }), item(30, { projectId: 'job-2', cc2Id: 'lawley' })], null);
    expect(lines.map((l) => [l.projectId, l.cc2Id, l.credit])).toEqual([['job-1', 'lawley', 70], ['job-2', 'lawley', 30]]);
  });
});
