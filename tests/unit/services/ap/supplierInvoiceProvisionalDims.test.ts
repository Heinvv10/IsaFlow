/**
 * Budgets P5-2b, breaker PROBE 3 (Hein's ruling, 2026-11-04): the pure rule a bill settling a bank-first provisional
 * inherits the provisional's dimensions by. Real-PG proof: tests/integration/budgets-p5-off-slice-provisional.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  inheritProvisionalDimensions, type ProvisionalDimLine,
} from '@/modules/accounting/services/ap/supplierInvoiceProvisionalDims';
import type { SupplierInvoice, SupplierInvoiceItem } from '@/modules/accounting/types/ap.types';

const item = (o: Partial<SupplierInvoiceItem> = {}): SupplierInvoiceItem => ({
  id: 'i1', supplierInvoiceId: 'b', description: 'x', quantity: 1, unitPrice: 800, taxRate: 15, taxAmount: 120,
  lineTotal: 800, glAccountId: 'opex', createdAt: '', ...o,
});
const bill = (items: SupplierInvoiceItem[], o: Partial<SupplierInvoice> = {}): SupplierInvoice => ({
  id: 'b', subtotal: items.reduce((s, i) => s + i.lineTotal, 0), taxRate: 15, totalAmount: 920, items, ...o,
} as SupplierInvoice);
const prov = (net: number, cc1Id: string | null, glAccountId = 'opex'): ProvisionalDimLine => ({ glAccountId, cc1Id, cc2Id: null, buId: null, net });
const cc1Of = (r: ReturnType<typeof inheritProvisionalDimensions>) => r.invoice.items!.map((i) => i.cc1Id ?? null);

describe('inheritProvisionalDimensions', () => {
  it('one provisional line on the account: its dimensions, whatever the amount', () => {
    const r = inheritProvisionalDimensions(bill([item()]), [prov(500, 'ft'), prov(120, null, 'vat')], 'defexp');
    expect(cc1Of(r)).toEqual(['ft']);
    expect(r.inherited.map((i) => i.id)).toEqual(['i1']);
  });
  it('several on the account: the one matching the posted net; none or two matching: nothing guessed', () => {
    expect(cc1Of(inheritProvisionalDimensions(bill([item()]), [prov(300, 'ft'), prov(800, 'ht')], 'defexp'))).toEqual(['ht']);
    expect(cc1Of(inheritProvisionalDimensions(bill([item()]), [prov(400, 'ft'), prov(400, 'ht')], 'defexp'))).toEqual([null]);
    expect(cc1Of(inheritProvisionalDimensions(bill([item()]), [prov(800, 'ft'), prov(800, 'ht')], 'defexp'))).toEqual([null]);
  });
  it('gross storage: matched on the net the line posts', () => {
    const gross = bill([item({ lineTotal: 920 })], { subtotal: 800 });
    expect(cc1Of(inheritProvisionalDimensions(gross, [prov(800, 'ft'), prov(100, 'ht')], 'defexp'))).toEqual(['ft']);
  });
  it('a line naming a dimension, or carrying the legacy pick (line or bill), is left alone', () => {
    for (const b of [bill([item({ cc1Id: 'ht' })]), bill([item({ buId: 'ops' })]), bill([item({ costCenterId: 'old' })]),
      bill([item()], { costCenterId: 'old' })]) {
      expect(inheritProvisionalDimensions(b, [prov(800, 'ft')], 'defexp').inherited).toEqual([]);
    }
  });
  it('a line with no account matches the default expense account it posts to; another account never matches', () => {
    expect(cc1Of(inheritProvisionalDimensions(bill([item({ glAccountId: undefined })]), [prov(800, 'ft', 'defexp')], 'defexp'))).toEqual(['ft']);
    expect(cc1Of(inheritProvisionalDimensions(bill([item()]), [prov(800, 'ft', 'travel')], 'defexp'))).toEqual([null]);
  });
  it('a provisional line with no dimensions gives nothing', () => {
    expect(inheritProvisionalDimensions(bill([item()]), [prov(800, null)], 'defexp').inherited).toEqual([]);
  });
});
