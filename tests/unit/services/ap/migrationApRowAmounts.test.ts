/**
 * checkTakeOnAmounts: the AP take-on importer's per-row amount rules, pure.
 * The DB-backed outcome (nothing over-paid is stored) is pinned in
 * tests/integration/ap-migration-amount-paid-within-total.int.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { checkTakeOnAmounts } from '@/modules/accounting/services/ap/migrationApRowAmounts';

const bill = (over: Partial<Parameters<typeof checkTakeOnAmounts>[0]> = {}) => ({
  invoiceNumber: 'BILL-1',
  subtotal: 100,
  taxAmount: 0,
  totalAmount: 100,
  amountPaid: 0,
  ...over,
});

describe('checkTakeOnAmounts', () => {
  it('passes a bill paid nothing, part, or exactly its total', () => {
    for (const amountPaid of [undefined, 0, 99.99, 100]) {
      expect(checkTakeOnAmounts(bill({ amountPaid }), 3)).toEqual({ error: null, warning: null });
    }
  });

  it.each([100.01, 100.04, 250])('refuses a bill paid %s on a total of 100 against its file row', (amountPaid) => {
    const v = checkTakeOnAmounts(bill({ amountPaid }), 7);
    expect(v.warning).toBeNull();
    expect(v.error).toMatchObject({ step: 'ap_invoices', row: 7, field: 'amountPaid' });
    expect(v.error!.message).toContain('exceeds its total of 100.00');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -5])('refuses an amount paid of %s the schema would have caught', (amountPaid) => {
    const v = checkTakeOnAmounts(bill({ amountPaid }), 6);
    expect(v.warning).toBeNull();
    expect(v.error).toMatchObject({ step: 'ap_invoices', row: 6, field: 'amountPaid' });
  });

  it.each([[1.005, 1.004], [100.005, 100.0049], [0.005, 0.004]])(
    'refuses %s paid on a total of %s: the column stores a cent more than the total', (amountPaid, total) => {
      const v = checkTakeOnAmounts(bill({ subtotal: total, totalAmount: total, amountPaid }), 0);
      expect(v.error).toMatchObject({ field: 'amountPaid' });
    });

  it('does not refuse float dust: 0.1 + 0.2 paid on a total of 0.3', () => {
    const v = checkTakeOnAmounts(bill({ subtotal: 0.3, totalAmount: 0.3, amountPaid: 0.1 + 0.2 }), 0);
    expect(v).toEqual({ error: null, warning: null });
  });

  it.each([
    ['total', { totalAmount: -1 }],
    ['subtotal', { subtotal: -1 }],
    ['tax', { taxAmount: -1 }],
    ['a non-finite leg', { taxAmount: Number.NaN }],
  ])('refuses a negative or non-finite %s', (_label, over) => {
    const v = checkTakeOnAmounts(bill(over), 2);
    expect(v.warning).toBeNull();
    expect(v.error).toMatchObject({ step: 'ap_invoices', row: 2, field: 'totalAmount' });
    expect(v.error!.message).toContain('may not carry');
  });

  it('warns, and still imports, on drift up to 5c', () => {
    const v = checkTakeOnAmounts(bill({ subtotal: 99.97, totalAmount: 100 }), 4);
    expect(v.error).toBeNull();
    expect(v.warning).toMatchObject({ step: 'ap_invoices', row: 4, field: 'totalAmount' });
    expect(v.warning!.message).toContain('rounding difference');
  });

  it('refuses drift beyond 5c', () => {
    const v = checkTakeOnAmounts(bill({ subtotal: 99.9, totalAmount: 100 }), 4);
    expect(v.warning).toBeNull();
    expect(v.error!.message).toContain('Amounts do not add up');
  });

  it('judges drift before payment: a drifting, over-paid row reports the drift', () => {
    const v = checkTakeOnAmounts(bill({ subtotal: 90, totalAmount: 100, amountPaid: 150 }), 1);
    expect(v.error!.message).toContain('Amounts do not add up');
  });
});
