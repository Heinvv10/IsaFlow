// R-088: the normalised content key that makes two reads of one slip match.
import { describe, expect, it } from 'vitest';
import {
  amountToCents,
  normaliseReceiptDate,
  normaliseReference,
  normaliseVendor,
  receiptContentKey,
  referencesDistinguish,
} from '@/modules/accounting/services/capture/receiptFingerprint';

describe('normaliseVendor', () => {
  it.each([
    ['Waltons Stationery'],
    ['WALTONS STATIONERY'],
    ['Waltons  Stationery (Pty) Ltd.'],
    ['waltons stationery limited'],
    ['Waltons-Stationery CC'],
    ['The Waltons Stationery'],
  ])('reads %j as waltonsstationery', (name) => {
    expect(normaliseVendor(name)).toBe('waltonsstationery');
  });

  it('joins words so spacing variants agree, reads & as and, folds accents', () => {
    expect(normaliseVendor('Pick n Pay')).toBe(normaliseVendor('PicknPay'));
    expect(normaliseVendor('Mugg & Bean')).toBe(normaliseVendor('Mugg and Bean'));
    expect(normaliseVendor('Café Olé')).toBe('cafeole');
  });

  it('keeps different vendors apart', () => {
    expect(normaliseVendor('Waltons')).not.toBe(normaliseVendor('Waltons Stationery'));
  });

  it('returns null for nothing to key on', () => {
    expect(normaliseVendor(null)).toBeNull();
    expect(normaliseVendor('  (Pty) Ltd ')).toBeNull();
    expect(normaliseVendor(42)).toBeNull();
  });
});

describe('normaliseReceiptDate', () => {
  it.each([
    ['2026-09-10'],
    ['2026/09/10'],
    ['2026-9-10'],
    ['2026-09-10T14:32:00+02:00'],
    ['10/09/2026'],
    ['10-09-26'],
    ['10.09.2026'],
    ['10 Sep 2026'],
    ['10 September 2026'],
    [' 10 sept. 2026 '],
  ])('reads %j as 2026-09-10 (day first)', (value) => {
    expect(normaliseReceiptDate(value)).toBe('2026-09-10');
  });

  it('refuses impossible and unreadable dates', () => {
    expect(normaliseReceiptDate('31/02/2026')).toBeNull();
    expect(normaliseReceiptDate('2026-13-01')).toBeNull();
    expect(normaliseReceiptDate('10 Foo 2026')).toBeNull();
    expect(normaliseReceiptDate('yesterday')).toBeNull();
    expect(normaliseReceiptDate(null)).toBeNull();
  });
});

describe('amountToCents', () => {
  it.each([
    [1150, 115000],
    [1150.5, 115050],
    [0.1 + 0.2, 30],
    ['1150', 115000],
    ['1150.00', 115000],
    ['R 1 150,00', 115000],
    ['R1,150.00', 115000],
    ['1.150,00', 115000],
    ['ZAR 1 150.00', 115000],
    ['1,150', 115000],
    ['150,00', 15000],
  ])('reads %j as %i cents', (value, cents) => {
    expect(amountToCents(value)).toBe(cents);
  });

  it('returns null for what is not an amount', () => {
    expect(amountToCents('about R100')).toBeNull();
    expect(amountToCents('')).toBeNull();
    expect(amountToCents(Number.NaN)).toBeNull();
    expect(amountToCents(null)).toBeNull();
  });
});

describe('receiptContentKey', () => {
  const slip = { vendorName: 'Waltons Stationery', date: '2026-09-10', totalAmount: 1150, vatAmount: 150 };

  it('gives two reads of one slip the same key', () => {
    expect(receiptContentKey({ vendorName: 'WALTONS STATIONERY (PTY) LTD', date: '10/09/2026', totalAmount: 'R1 150,00', vatAmount: '150.00' }))
      .toBe(receiptContentKey(slip));
    expect(receiptContentKey(slip)).toBe('v1|waltonsstationery|2026-09-10|115000|15000');
  });

  it('changes with each part of the key', () => {
    const key = receiptContentKey(slip);
    expect(receiptContentKey({ ...slip, vendorName: 'CNA' })).not.toBe(key);
    expect(receiptContentKey({ ...slip, date: '2026-09-11' })).not.toBe(key);
    expect(receiptContentKey({ ...slip, totalAmount: 1150.01 })).not.toBe(key);
    expect(receiptContentKey({ ...slip, vatAmount: 149.99 })).not.toBe(key);
  });

  it('keys an unread VAT figure as none, distinct from a zero one', () => {
    expect(receiptContentKey({ ...slip, vatAmount: null })).toBe('v1|waltonsstationery|2026-09-10|115000|none');
    expect(receiptContentKey({ ...slip, vatAmount: 0 })).toBe('v1|waltonsstationery|2026-09-10|115000|0');
  });

  it('has no key without a vendor, a date or a total', () => {
    expect(receiptContentKey({ ...slip, vendorName: null })).toBeNull();
    expect(receiptContentKey({ ...slip, date: null })).toBeNull();
    expect(receiptContentKey({ ...slip, totalAmount: null })).toBeNull();
  });
});

describe('referencesDistinguish', () => {
  it('tells two receipts apart only when both printed numbers were read and differ', () => {
    expect(referencesDistinguish('TS-4471', 'TS-4502')).toBe(true);
    expect(referencesDistinguish('TS-4471', 'ts 4471')).toBe(false);
    expect(referencesDistinguish('TS-4471', null)).toBe(false);
    expect(referencesDistinguish(null, 'TS-4502')).toBe(false);
    expect(referencesDistinguish('', '--')).toBe(false);
  });

  it('compares a reference on its letters and digits', () => {
    expect(normaliseReference('inv/00123')).toBe('INV00123');
    expect(normaliseReference(4471)).toBe('4471');
  });
});
