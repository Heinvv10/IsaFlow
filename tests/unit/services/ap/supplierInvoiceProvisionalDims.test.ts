/**
 * Budgets P5-2b (breaker round 2, coordinator's ruling 2026-11-04): the pure matching rule a slip bill's blank draft
 * lines inherit the bank-first provisional's dimensions by, failing closed. Real-PG proof (validation, the draft
 * writers, approve reading stored lines only): tests/integration/budgets-p5-off-slice-provisional*.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  matchProvisionalDimensions, type InheritLine, type ProvisionalDimLine,
} from '@/modules/accounting/services/ap/supplierInvoiceProvisionalDims';
import { buildExpenseLines, expenseLineNets } from '@/modules/accounting/services/ap/supplierInvoiceExpenseLines';
import type { SupplierInvoice } from '@/modules/accounting/types/ap.types';

const line = (net: number, o: Partial<InheritLine> = {}): InheritLine => ({ account: 'opex', net, blank: true, ...o });
const prov = (net: number, cc1Id: string | null, glAccountId = 'opex'): ProvisionalDimLine => ({ glAccountId, cc1Id, cc2Id: null, buId: null, net });
const cc1 = (r: ReturnType<typeof matchProvisionalDimensions>) => r.map((d) => d?.cc1Id ?? null);

describe('matchProvisionalDimensions', () => {
  it('one candidate whose amount is the blank lines\' sum: every blank line inherits (one line, or two summing to it)', () => {
    expect(cc1(matchProvisionalDimensions([line(800)], [prov(800, 'ft'), prov(120, null, 'vat')]))).toEqual(['ft']);
    expect(cc1(matchProvisionalDimensions([line(500), line(300)], [prov(800, 'ft')]))).toEqual(['ft', 'ft']);
  });
  it('breaker C: a single FT 100 candidate against blank lines of 800 and 50 inherits nothing', () => {
    expect(cc1(matchProvisionalDimensions([line(800), line(50)], [prov(100, 'ft')]))).toEqual([null, null]);
  });
  it('breaker D: FT 400 + FT 400 against an 800 line inherits FT (all candidates agree and the sums match)', () => {
    expect(cc1(matchProvisionalDimensions([line(800)], [prov(400, 'ft'), prov(400, 'ft')]))).toEqual(['ft']);
  });
  it('different candidates: each blank line takes the ONE candidate of its own amount; none or two: nothing', () => {
    expect(cc1(matchProvisionalDimensions([line(500), line(300)], [prov(500, 'ft'), prov(300, 'ht')]))).toEqual(['ft', 'ht']);
    expect(cc1(matchProvisionalDimensions([line(800)], [prov(400, 'ft'), prov(400, 'ht')]))).toEqual([null]);
    expect(cc1(matchProvisionalDimensions([line(500), line(500)], [prov(500, 'ft'), prov(500, 'ht')]))).toEqual([null, null]);
  });
  it('each candidate is taken by one line at most: two blank 400 lines and ONE FT 400 candidate (plus HT 300) inherit nothing', () => {
    expect(cc1(matchProvisionalDimensions([line(400), line(400)], [prov(400, 'ft'), prov(300, 'ht')]))).toEqual([null, null]);
    // A line whose own candidate is unique still inherits beside them.
    expect(cc1(matchProvisionalDimensions([line(400), line(400), line(300)], [prov(400, 'ft'), prov(300, 'ht')]))).toEqual([null, null, 'ht']);
  });
  it('amounts within one cent match; two cents do not', () => {
    expect(cc1(matchProvisionalDimensions([line(300.01), line(223.74)], [prov(300, 'ft'), prov(223.74, 'ht')]))).toEqual(['ft', 'ht']);
    expect(cc1(matchProvisionalDimensions([line(800.02)], [prov(800, 'ft'), prov(1, 'ht')]))).toEqual([null]);
  });
  it('a line naming a dimension is not blank and is never matched; nor counted in the sum', () => {
    expect(cc1(matchProvisionalDimensions([line(500, { blank: false }), line(300)], [prov(300, 'ft')]))).toEqual([null, 'ft']);
  });
  it('another account never matches; a candidate with no dimensions, or a credit, gives nothing', () => {
    expect(cc1(matchProvisionalDimensions([line(800)], [prov(800, 'ft', 'travel')]))).toEqual([null]);
    expect(cc1(matchProvisionalDimensions([line(800)], [prov(800, null)]))).toEqual([null]);
    expect(cc1(matchProvisionalDimensions([line(800)], [prov(-800, 'ft')]))).toEqual([null]);
  });
});

describe('expenseLineNets: the nets the matcher sees are the nets buildExpenseLines posts', () => {
  // Gross storage: five R10 lines and a R50 line, R100 incl. 15% VAT, subtotal 86.96. Each non-final line posts 8.70
  // (rounded) and the last absorbs the residual: 43.46, where an unrounded proportional share would be 43.48.
  const gross = [10, 10, 10, 10, 10, 50];
  const header = { subtotal: 86.96, totalAmount: 100, taxRate: 15 };
  const items = gross.map((lineTotal, i) => ({
    id: `i${i}`, supplierInvoiceId: 'si', description: `l${i}`, quantity: 1, unitPrice: lineTotal, taxRate: 15, taxAmount: 0,
    lineTotal, glAccountId: i < 5 ? 'other' : 'opex', createdAt: '2026-11-04',
  }));

  it('equals buildExpenseLines\' debits, residual on the last line', () => {
    const posted = buildExpenseLines({ ...header, id: 'si', invoiceNumber: 'B', supplierId: 's', invoiceDate: '2026-11-04',
      taxAmount: 13.04, amountPaid: 0, balance: 100, status: 'draft', items } as SupplierInvoice, 'opex').map((l) => l.debit);
    expect(expenseLineNets(items, header)).toEqual(posted);
    expect(posted).toEqual([8.7, 8.7, 8.7, 8.7, 8.7, 43.46]);
  });
  it('the last blank line matches the provisional line of its POSTED net (43.46), not the unrounded share (43.48)', () => {
    const nets = expenseLineNets(items, header);
    const lines = items.map((l, i) => ({ account: l.glAccountId, net: nets[i]!, blank: i === 5 }));
    expect(cc1(matchProvisionalDimensions(lines, [prov(43.46, 'ht'), prov(43.5, 'ft')]))).toEqual([null, null, null, null, null, 'ht']);
  });
});
