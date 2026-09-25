/**
 * The pure rules of a late input-VAT claim (VAT Act s16(3)): which journals
 * dated in a locked VAT period may be split, the date the claim lands on, and
 * the five-year window.
 */
import { describe, expect, it } from 'vitest';
import {
  qualifiesForLateClaim,
  lateClaimDate,
  lateClaimDeadline,
  isWithinLateClaimWindow,
  type LateClaimLine,
} from '@/modules/accounting/services/gl/vatLateClaimRules';

function line(over: Partial<LateClaimLine>): LateClaimLine {
  return {
    glAccountId: 'acc', accountType: 'expense', accountSubtype: 'operating_expense',
    accountName: 'Office Supplies', vatInputDenied: false, vatType: null, debit: 0, credit: 0, ...over,
  };
}
const expense = (amt: number, vatType: string | null = 'standard', over: Partial<LateClaimLine> = {}) =>
  line({ debit: amt, vatType, ...over });
const inputVat = (debit: number, credit = 0, vatType: string | null = 'standard') =>
  line({ glAccountId: 'vin', accountType: 'asset', accountSubtype: 'vat_input', accountName: 'VAT Input', debit, credit, vatType });
const outputVat = (credit: number, vatType = 'reverse_charge') =>
  line({ glAccountId: 'vout', accountType: 'liability', accountSubtype: 'vat_output', accountName: 'VAT Output', credit, vatType });
const payable = (credit: number, debit = 0) =>
  line({ glAccountId: 'ap', accountType: 'liability', accountSubtype: 'payable', accountName: 'Trade Payables', credit, debit });

describe('qualifiesForLateClaim', () => {
  it('a plain bill (expense + input VAT debit / AP) is claimable, and says how much', () => {
    expect(qualifiesForLateClaim([expense(1000), inputVat(150), payable(1150)]))
      .toEqual({ claimable: true, inputTax: 150 });
  });

  it('a capital-goods bill on a fixed asset is claimable', () => {
    const asset = line({ accountType: 'asset', accountSubtype: 'fixed_asset', accountName: 'Vehicles', debit: 1000, vatType: 'capital_goods' });
    expect(qualifiesForLateClaim([asset, inputVat(150, 0, 'capital_goods'), payable(1150)]))
      .toEqual({ claimable: true, inputTax: 150 });
  });

  it('DRC (output + input legs) refuses output_vat', () => {
    expect(qualifiesForLateClaim([expense(1000, 'reverse_charge'), inputVat(150, 0, 'reverse_charge'), outputVat(150), payable(1000)]))
      .toEqual({ claimable: false, reason: 'output_vat' });
  });

  it('a supplier credit note (credit to vat_input) refuses input_reduction', () => {
    expect(qualifiesForLateClaim([payable(0, 1150), line({ credit: 1000, vatType: 'standard' }), inputVat(0, 150)]))
      .toEqual({ claimable: false, reason: 'input_reduction' });
  });

  it('a VAT tag on a revenue account refuses output_vat', () => {
    const rev = line({ accountType: 'revenue', accountSubtype: 'revenue', accountName: 'Sales', credit: 1000, vatType: 'zero_rated' });
    expect(qualifiesForLateClaim([rev, line({ glAccountId: 'bank', accountType: 'asset', accountSubtype: 'bank', debit: 1000 })]))
      .toEqual({ claimable: false, reason: 'output_vat' });
  });

  it('mixed: a bill that also carries a tagged revenue line refuses output_vat', () => {
    const rev = line({ accountType: 'revenue', accountSubtype: 'other_income', accountName: 'Rebates', credit: 100, vatType: 'standard' });
    expect(qualifiesForLateClaim([expense(1100), rev, inputVat(150), payable(1150)]))
      .toEqual({ claimable: false, reason: 'output_vat' });
  });

  it('a VAT tag on a no-treatment balance-sheet account is today\'s plain refusal (reason null)', () => {
    const loan = line({ accountType: 'liability', accountSubtype: 'other_current_liability', accountName: 'Director loan', debit: 1000, vatType: 'standard' });
    // other_current_liability is a settlement subtype; a loan with no subtype is the unmapped case.
    const unmapped = line({ accountType: 'liability', accountSubtype: null, accountName: 'Director loan', debit: 1000, vatType: 'standard' });
    expect(qualifiesForLateClaim([unmapped, inputVat(150), payable(1150)]))
      .toEqual({ claimable: false, reason: null });
    // A tag on a SETTLEMENT subtype is placeable; with a base line beside it the claim stands.
    expect(qualifiesForLateClaim([expense(1000), loan, inputVat(150), payable(2150)]).claimable).toBe(true);
  });

  it('nothing to claim (tagged base only, no input VAT) is today\'s plain refusal', () => {
    expect(qualifiesForLateClaim([expense(1000, 'zero_rated'), payable(1000)]))
      .toEqual({ claimable: false, reason: null });
  });

  it('a VAT-coded line on a non-supply account refuses non_supply', () => {
    expect(qualifiesForLateClaim([expense(1000, 'standard', { accountName: 'Donations' }), inputVat(150), payable(1150)]))
      .toEqual({ claimable: false, reason: 'non_supply' });
  });

  it('a VAT-coded line on a vat_input_denied account refuses non_supply', () => {
    expect(qualifiesForLateClaim([expense(1000, 'standard', { vatInputDenied: true, accountName: 'Entertainment' }), inputVat(150), payable(1150)]))
      .toEqual({ claimable: false, reason: 'non_supply' });
  });

  it('a non-supply or denied account coded as claiming NO VAT (no_vat / exempt) does not block the split', () => {
    const lines = [
      expense(1000),
      expense(200, 'no_vat', { accountName: 'Donations' }),
      expense(50, 'exempt', { vatInputDenied: true, accountName: 'Entertainment' }),
      inputVat(150), payable(1400),
    ];
    expect(qualifiesForLateClaim(lines)).toEqual({ claimable: true, inputTax: 150 });
  });

  it('an UNTAGGED line on a denied or non-supply account refuses non_supply (the VAT may be its)', () => {
    expect(qualifiesForLateClaim([expense(100, null, { vatInputDenied: true, accountName: 'Staff functions' }), inputVat(15), payable(115)]))
      .toEqual({ claimable: false, reason: 'non_supply' });
    expect(qualifiesForLateClaim([expense(100, null, { accountName: 'Donations' }), inputVat(15), payable(115)]))
      .toEqual({ claimable: false, reason: 'non_supply' });
  });

  it('input VAT with NO base line at all (DR VAT Input / CR Bank) is not claimable: the return would flag it', () => {
    const bank = line({ glAccountId: 'bank', accountType: 'asset', accountSubtype: 'bank', accountName: 'Bank', credit: 15 });
    expect(qualifiesForLateClaim([inputVat(15), bank])).toEqual({ claimable: false, reason: null });
  });

  it('an untagged expense line IS a base line: a bill (expense lines carry no code) stays claimable', () => {
    expect(qualifiesForLateClaim([expense(1000, null), inputVat(150), payable(1150)]))
      .toEqual({ claimable: true, inputTax: 150 });
  });
});

describe('qualifiesForLateClaim — the 15% check the VAT201 would run on time', () => {
  const bank = (credit: number) => line({ glAccountId: 'bank', accountType: 'asset', accountSubtype: 'bank', accountName: 'Bank', credit });

  it('a normal bill (untagged expense lines, base = every base line, as the VAT201 derives it) splits', () => {
    expect(qualifiesForLateClaim([expense(1000, null), inputVat(150), payable(1150)]).claimable).toBe(true);
  });

  it('a bill with an untaxed item beside a taxed one splits (under 15% of the whole base is not an over-claim)', () => {
    expect(qualifiesForLateClaim([expense(1000, null), expense(500, null), inputVat(150), payable(1650)]).claimable).toBe(true);
  });

  it('a padded untagged claim (R15 of VAT on a R0.01 base) is not claimable', () => {
    expect(qualifiesForLateClaim([expense(0.01, null), inputVat(15), bank(15.01)])).toEqual({ claimable: false, reason: null });
  });

  it('a padded CODED claim (R15 on a R0.01 standard line) is not claimable', () => {
    expect(qualifiesForLateClaim([expense(0.01, 'standard'), inputVat(15), bank(15.01)])).toEqual({ claimable: false, reason: null });
  });

  it('coded lines are checked both ways: R100 on a R1 000 standard base is not claimable, R150 is', () => {
    expect(qualifiesForLateClaim([expense(1000, 'standard'), inputVat(100), payable(1100)])).toEqual({ claimable: false, reason: null });
    expect(qualifiesForLateClaim([expense(1000, 'standard'), inputVat(150), payable(1150)]).claimable).toBe(true);
  });

  it('only TAX-BEARING codes carry the coded base: a zero-rated line beside a standard one does not dilute it', () => {
    expect(qualifiesForLateClaim([expense(1000, 'standard'), expense(500, 'zero_rated'), inputVat(150), payable(1650)]).claimable).toBe(true);
  });

  it('within the R1 tolerance passes; just over it does not', () => {
    expect(qualifiesForLateClaim([expense(1000, 'standard'), inputVat(151), payable(1151)]).claimable).toBe(true);
    expect(qualifiesForLateClaim([expense(1000, 'standard'), inputVat(151.02), payable(1151.02)]).claimable).toBe(false);
  });
});

describe('lateClaimDate', () => {
  it('is the day after the lock covering the original', () => {
    expect(lateClaimDate('2026-07-15', [{ periodStart: '2026-07-01', periodEnd: '2026-08-31' }])).toBe('2026-09-01');
  });

  it('skips back-to-back locks', () => {
    const locks = [
      { periodStart: '2026-09-01', periodEnd: '2026-10-31' },
      { periodStart: '2026-07-01', periodEnd: '2026-08-31' },
      { periodStart: '2027-01-01', periodEnd: '2027-02-28' }, // not consecutive: a gap in Nov-Dec
    ];
    expect(lateClaimDate('2026-07-15', locks)).toBe('2026-11-01');
  });

  it('crosses a year end', () => {
    expect(lateClaimDate('2026-12-10', [{ periodStart: '2026-11-01', periodEnd: '2026-12-31' }])).toBe('2027-01-01');
  });

  it('throws when no lock covers the date (a caller bug, not a refusal)', () => {
    expect(() => lateClaimDate('2026-06-15', [{ periodStart: '2026-07-01', periodEnd: '2026-08-31' }])).toThrow();
  });
});

describe('five-year window (s16(3) proviso)', () => {
  it('the deadline is the same calendar day five years on', () => {
    expect(lateClaimDeadline('2021-09-01')).toBe('2026-09-01');
  });

  it('the last day passes; the next day refuses', () => {
    expect(isWithinLateClaimWindow('2021-09-01', '2026-09-01')).toBe(true);
    expect(isWithinLateClaimWindow('2021-09-01', '2026-09-02')).toBe(false);
  });

  it('29 February clamps to 28 February', () => {
    expect(lateClaimDeadline('2024-02-29')).toBe('2029-02-28');
    expect(isWithinLateClaimWindow('2024-02-29', '2029-02-28')).toBe(true);
    expect(isWithinLateClaimWindow('2024-02-29', '2029-03-01')).toBe(false);
  });
});
