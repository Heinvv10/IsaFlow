import { describe, it, expect } from 'vitest';
import { netCredits } from '@/modules/accounting/services/cashForecast13/creditNetting';
import { convertDocs, excludedMessage } from '@/modules/accounting/services/cashForecast13/fx';
import type { KnownItem } from '@/modules/accounting/services/cashForecast13/types';

const it_ = (ref: string, date: string, amountCents: number, entityId = 'c1'): KnownItem => ({
  lineKey: `x:${entityId}`, lineLabel: 'x', category: 'customer_receipts', entityId, date, amountCents, ref, refLabel: ref,
});

describe('cash13 unapplied credit netting (review M2)', () => {
  it('reviewer case: R100k invoice, R40k credit → R60k expected', () => {
    const r = netCredits([it_('i1', '2026-11-20', 100_000_00)], new Map([['c1', 40_000_00]]));
    expect(r.items.map((i) => i.amountCents)).toEqual([60_000_00]);
    expect(r.unused).toEqual([]);
  });

  it('nets earliest first, never below zero per invoice; a netted-out invoice is dropped; another entity untouched', () => {
    const r = netCredits([it_('late', '2026-12-20', 500), it_('early', '2026-11-20', 300), it_('o', '2026-11-01', 900, 'c2')], new Map([['c1', 400]]));
    expect(r.items.map((i) => [i.ref, i.amountCents])).toEqual([['late', 400], ['o', 900]]);
  });

  it('works on payments (negative items) and reports credit left over', () => {
    const r = netCredits([{ ...it_('b1', '2026-11-20', -300, 's1'), category: 'supplier_payments' }], new Map([['s1', 1_000], ['s9', 50], ['s8', -20]]));
    expect(r.items).toEqual([]);
    expect(r.unused).toEqual([{ entityId: 's1', cents: 700 }, { entityId: 's9', cents: 50 }]);
  });
});

describe('cash13 foreign currency (review L6)', () => {
  const doc = (id: string, balanceCents: number, disputedCents = 0) => ({ id, balanceCents, disputedCents });
  it('converts at the document’s stored rate; leaves out one with no usable rate; functional or unnamed pass through', () => {
    const fx = new Map([
      ['usd', { currency: 'USD', rate: 18.5 }], ['eur', { currency: 'EUR', rate: null }], ['gbp', { currency: 'GBP', rate: 0 }],
      ['zar', { currency: 'ZAR', rate: 1 }], ['none', { currency: null, rate: null }],
    ]);
    const r = convertDocs([doc('usd', 1_000, 100), doc('eur', 2_000), doc('gbp', 3_000), doc('zar', 4_000), doc('none', 5_000), doc('nofx', 6_000)], fx, 'ZAR');
    expect(r.docs).toEqual([doc('usd', 18_500, 1_850), doc('zar', 4_000), doc('none', 5_000), doc('nofx', 6_000)]);
    expect([...r.excluded]).toEqual([['EUR', { count: 1, cents: 2_000 }], ['GBP', { count: 1, cents: 3_000 }]]);
    expect(excludedMessage('Customer invoices', r.excluded)).toBe('Customer invoices in another currency with no stored exchange rate are left out: 1 in EUR (20.00 EUR); 1 in GBP (30.00 GBP)');
  });
});
