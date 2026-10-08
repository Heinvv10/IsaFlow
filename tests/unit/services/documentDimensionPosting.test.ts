/**
 * Dimensions Phase 1 — documents carry CC1/CC2/BU onto their GL lines.
 *
 * Bills: each item's dimensions ride on its EXPENSE leg; the AP and VAT legs
 * the workflow adds carry none. Customer invoices: one revenue line per
 * distinct (CC1, CC2, BU), summing exactly to the subtotal; the FNO defaults
 * from the customer and a conflicting one is refused; with no dimension
 * anywhere the journal is the single revenue line it always was.
 */
import { describe, expect, it } from 'vitest';
import { buildExpenseLines } from '@/modules/accounting/services/ap/supplierInvoiceExpenseLines';
import { buildRevenueLines, parseRevenueItems } from '@/modules/accounting/services/ar/customerInvoiceRevenueLines';
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

describe('customer invoice revenue legs', () => {
  const base = { revenueAccountId: 'rev', invoiceNumber: 'INV-1' };

  it('is the SAME single revenue line as before when nothing names a dimension', () => {
    expect(buildRevenueLines({ ...base, subtotal: 1000, items: [{ amount: 600 }, { amount: 400 }], customerFnoId: null }))
      .toEqual([{ glAccountId: 'rev', debit: 0, credit: 1000, description: 'Revenue: INV-1' }]);
  });

  it('takes the customer FNO on revenue when the items name none', () => {
    const lines = buildRevenueLines({ ...base, subtotal: 1000, items: [{ amount: 1000 }], customerFnoId: 'FNO-FT' });
    expect(lines).toEqual([{ glAccountId: 'rev', debit: 0, credit: 1000, description: 'Revenue: INV-1', cc1Id: 'fno-ft' }]);
  });

  it('splits the subtotal by (CC1, CC2, BU), summing EXACTLY to it', () => {
    const lines = buildRevenueLines({
      ...base, subtotal: 1000.01, customerFnoId: 'fno-ft',
      items: [
        { amount: 333.33, cc2Id: 'lawley', buId: 'act' },
        { amount: 333.34, cc2Id: 'lawley', buId: 'act' },
        { amount: 333.34, cc2Id: 'mohadin', buId: 'civ' },
      ],
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ credit: 666.67, cc1Id: 'fno-ft', cc2Id: 'lawley', buId: 'act' });
    expect(lines[1]).toMatchObject({ credit: 333.34, cc1Id: 'fno-ft', cc2Id: 'mohadin', buId: 'civ' });
    const total = lines.reduce((s, l) => s + l.credit, 0);
    expect(Math.round(total * 100) / 100).toBe(1000.01);
    // The whole journal still balances through the real validator.
    const journal = [{ glAccountId: 'ar', debit: 1150.01, credit: 0 }, ...lines, { glAccountId: 'vat', debit: 0, credit: 150 }];
    expect(validateJournalEntry(journal).valid).toBe(true);
  });

  it('REFUSES an item whose FNO differs from the customer FNO', () => {
    expect(() => buildRevenueLines({
      ...base, subtotal: 100, customerFnoId: 'fno-ft', items: [{ amount: 100, cc1Id: 'fno-herotel' }],
    })).toThrow(/differs from the customer's FNO/);
  });

  it('falls back to one line (customer FNO only) when a group nets to zero or below', () => {
    const lines = buildRevenueLines({
      ...base, subtotal: 900, customerFnoId: 'fno-ft',
      items: [{ amount: 1000, buId: 'build' }, { amount: -100, buId: 'disc' }],
    });
    expect(lines).toEqual([{ glAccountId: 'rev', debit: 0, credit: 900, description: 'Revenue: INV-1', cc1Id: 'fno-ft' }]);
  });

  it('parses the posting query\'s json_agg in both shapes', () => {
    const rows = [{ amount: '12.50', cc1_id: null, cc2_id: 'p', bu_id: null }];
    expect(parseRevenueItems(rows)).toEqual([{ amount: 12.5, cc2Id: 'p' }]);
    expect(parseRevenueItems(JSON.stringify(rows))).toEqual([{ amount: 12.5, cc2Id: 'p' }]);
    expect(parseRevenueItems(null)).toEqual([]);
  });
});
