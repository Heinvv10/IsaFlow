/** planBillLinks (pure): the amount rule the app writer and the migration's backfill share (design decision 4). */
import { describe, expect, it } from 'vitest';
import { planBillLinks } from '@/modules/accounting/services/ap/billPurchaseOrderLinks';

const l = (poId: string | null, postedCents: number) => ({ poId, postedCents });

describe('planBillLinks', () => {
  it('a PO the lines name gets the posted amount of those lines; a header-only PO the remainder of the subtotal', () => {
    expect(planBillLinks({ subtotalCents: 10000, lines: [l('b', 3000), l('a', 2000), l(null, 5000)], headerPoId: 'z' }))
      .toEqual([{ poId: 'b', amountCents: 3000 }, { poId: 'a', amountCents: 2000 }, { poId: 'z', amountCents: 5000 }]);
  });
  it('lines that post nothing fall back to the remainder; of several such POs only the lowest id is linked', () => {
    expect(planBillLinks({ subtotalCents: 10000, lines: [l('q', 0), l('p', 0)], headerPoId: null })).toEqual([{ poId: 'p', amountCents: 10000 }]);
  });
  it('the header PO the lines also name takes the lines\' amount, not the subtotal', () => {
    expect(planBillLinks({ subtotalCents: 10000, lines: [l('h', 7000), l(null, 3000)], headerPoId: 'h' })).toEqual([{ poId: 'h', amountCents: 7000 }]);
  });
  it('never links an amount at or below zero', () => {
    expect(planBillLinks({ subtotalCents: 5000, lines: [l('a', 5000)], headerPoId: 'h' })).toEqual([{ poId: 'a', amountCents: 5000 }]);
    expect(planBillLinks({ subtotalCents: 0, lines: [l('a', 0)], headerPoId: null })).toEqual([]);
    expect(planBillLinks({ subtotalCents: 1000, lines: [], headerPoId: null })).toEqual([]);
  });
});
