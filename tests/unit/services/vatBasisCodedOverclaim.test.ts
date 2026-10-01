/**
 * The VAT201 basis (deriveVatBoxesWithLateClaims) with the coded-base rule and
 * the per-journal input over-claim wired in, and the late-claim rules sharing
 * the same coded-base rule.
 */
import { describe, expect, it } from 'vitest';
import { deriveVatBoxesWithLateClaims, type LateClaimAwareLine } from '@/modules/accounting/services/reports/vatLateClaimBasis';
import { lateClaimBases, qualifiesForLateClaim, type LateClaimLine } from '@/modules/accounting/services/gl/vatLateClaimRules';

let n = 0;
const line = (je: string, over: Partial<LateClaimAwareLine>): LateClaimAwareLine => ({
  journalEntryId: je, entryNumber: je, entryDate: '2026-09-10', lineId: `l${++n}`,
  accountId: 'exp', accountCode: '6000', accountName: 'Expense', accountType: 'expense',
  accountSubtype: 'operating_expense', vatType: null, debit: 0, credit: 0, cancelledSource: false,
  entrySource: 'manual', ...over,
});
const vatIn = (je: string, debit: number, credit = 0) =>
  line(je, { accountId: 'vin', accountType: 'asset', accountSubtype: 'vat_input', vatType: 'standard', debit, credit });
const bank = (je: string, credit: number) =>
  line(je, { accountId: 'bank', accountType: 'asset', accountSubtype: 'bank', credit });
const bill = (je: string, base: number, tax: number) => [line(je, { debit: base }), vatIn(je, tax), bank(je, base + tax)];
// Coded R1 000 standard + an uncoded R5 000 line; the tax is 15% of the coded line.
const mixed = [line('mix', { debit: 1000, vatType: 'standard' }), line('mix', { debit: 5000 }), vatIn('mix', 150), bank('mix', 6150)];

describe('deriveVatBoxesWithLateClaims — coded base + per-journal over-claim', () => {
  it('a mixed-coded journal ties on its coded base (was an under-claim of 750)', () => {
    const r = deriveVatBoxesWithLateClaims(mixed);
    const box = r.boxes.find((b) => b.direction === 'input' && b.vatType === 'standard')!;
    expect(box).toMatchObject({ base: 1000, tax: 150, variance: 0 });
    expect(r.inputVariance).toBe(0);
    expect(r.ties).toBe(true);
  });

  it('an under-claim no longer hides an over-claim: variance = the over-claim, ties false', () => {
    const r = deriveVatBoxesWithLateClaims([...bill('under', 1000, 100), ...bill('over', 1000, 200)]);
    expect(r.inputTax).toBe(300);
    // 50 shown in full — a single taxed input-VAT line's R0.005 rounding allowance (item 9) does not survive cent-rounding.
    expect(r.inputVariance).toBe(50);
    expect(r.ties).toBe(false);
    // The displayed box is still the signed total.
    expect(r.boxes.find((b) => b.direction === 'input')!.variance).toBe(0);
  });

  it('a mixed-coded journal no longer hides an over-claim elsewhere', () => {
    const r = deriveVatBoxesWithLateClaims([...mixed, ...bill('over', 1000, 900)]);
    // 750 shown in full — a single taxed input-VAT line's R0.005 rounding allowance (item 9) does not survive cent-rounding.
    expect(r.inputVariance).toBe(750);
  });

  it('ordinary bills still tie', () => {
    const r = deriveVatBoxesWithLateClaims([...bill('a', 1000, 150), ...bill('b', 2000, 300)]);
    expect(r.inputVariance).toBe(0);
    expect(r.ties).toBe(true);
  });

  it('output variance is untouched (signed, per return)', () => {
    const sale = [line('s', { accountType: 'revenue', accountSubtype: 'sales', credit: 1000 }),
      line('s', { accountId: 'vout', accountType: 'liability', accountSubtype: 'vat_output', vatType: 'standard', credit: 140 }),
      line('s', { accountId: 'ar', accountType: 'asset', accountSubtype: 'receivable', debit: 1140 })];
    expect(deriveVatBoxesWithLateClaims(sale).outputVariance).toBe(-10);
  });
});

const lc = (over: Partial<LateClaimLine>): LateClaimLine => ({
  glAccountId: 'exp', accountType: 'expense', accountSubtype: 'operating_expense', accountName: 'Expense',
  vatInputDenied: false, vatType: null, debit: 0, credit: 0, ...over,
});
const lcVat = (debit: number) => lc({ glAccountId: 'vin', accountType: 'asset', accountSubtype: 'vat_input', vatType: 'standard', debit });
const lcAp = (credit: number) => lc({ glAccountId: 'ap', accountType: 'liability', accountSubtype: 'payable', credit });

describe('late-claim rules share the coded-base rule', () => {
  it('lateClaimBases stores the CODED base on a mixed journal (what the VAT201 now uses on time)', () => {
    const lines = [lc({ debit: 1000, vatType: 'standard' }), lc({ debit: 5000 }), lcVat(150), lcAp(6150)];
    expect(lateClaimBases(lines)).toEqual([1000]);
  });

  it('qualifiesForLateClaim: a mixed journal on its coded base is claimable; padded, it is not', () => {
    const ok = [lc({ debit: 1000, vatType: 'standard' }), lc({ debit: 5000 }), lcVat(150), lcAp(6150)];
    const padded = [lc({ debit: 1000, vatType: 'standard' }), lc({ debit: 5000 }), lcVat(400), lcAp(6400)];
    expect(qualifiesForLateClaim(ok)).toEqual({ claimable: true, inputTax: 150 });
    expect(qualifiesForLateClaim(padded)).toEqual({ claimable: false, reason: null });
  });

  it('qualifiesForLateClaim: an uncoded bill with a zero-rated item still qualifies (under-claim)', () => {
    const lines = [lc({ debit: 1000 }), lc({ debit: 500, vatType: 'zero_rated' }), lcVat(150), lcAp(1650)];
    expect(qualifiesForLateClaim(lines)).toEqual({ claimable: true, inputTax: 150 });
  });
});
