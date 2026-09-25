/**
 * A late-claim companion (DR VAT Input / CR "Input VAT - late claims") carries
 * input tax with NO base leg: its supply was recorded in the locked period, on
 * the original. The VAT201 must put exactly its tax in the right box, keep the
 * 15% base check honest by leaving that tax out of the variance, and not list
 * the companion as a journal without a base.
 */
import { describe, expect, it } from 'vitest';
import { deriveVatBoxes, type VatLineInput } from '@/modules/accounting/services/reports/vatBoxBasis';
import { deriveVatBoxesWithLateClaims } from '@/modules/accounting/services/reports/vatLateClaimBasis';

let n = 0;
const line = (je: string, over: Partial<VatLineInput>): VatLineInput => ({
  journalEntryId: je, entryNumber: je, entryDate: '2026-09-10', lineId: `l${++n}`,
  accountId: 'a', accountCode: '0', accountName: 'x', accountType: 'expense',
  accountSubtype: 'operating_expense', vatType: null, debit: 0, credit: 0, cancelledSource: false, ...over,
});
const vatIn = (je: string, debit: number, credit = 0, vatType = 'standard') =>
  line(je, { accountId: 'vin', accountType: 'asset', accountSubtype: 'vat_input', vatType, debit, credit });
const clearing = (je: string, debit: number, credit: number) =>
  line(je, { accountId: 'clr', accountType: 'asset', accountSubtype: 'vat_input_late_claim', debit, credit });

// An ordinary bill in the claim period: base 1000, tax 150.
const bill = [
  line('bill', { debit: 1000 }),
  vatIn('bill', 150),
  line('bill', { accountId: 'ap', accountType: 'liability', accountSubtype: 'payable', credit: 1150 }),
];
// The companion of a bill dated in a locked period: 80 of capital-goods tax, 45 standard.
const companion = [vatIn('comp', 80, 0, 'capital_goods'), vatIn('comp', 45), clearing('comp', 0, 125)];

describe('deriveVatBoxesWithLateClaims', () => {
  it('adds exactly the companion tax to its boxes, and the base check still ties', () => {
    const r = deriveVatBoxesWithLateClaims([...bill, ...companion]);
    const std = r.boxes.find((b) => b.direction === 'input' && b.vatType === 'standard')!;
    const cap = r.boxes.find((b) => b.direction === 'input' && b.vatType === 'capital_goods')!;
    expect(std).toMatchObject({ base: 1000, tax: 195, lateClaimTax: 45, impliedTax: 150, variance: 0 });
    expect(cap).toMatchObject({ base: 0, tax: 80, lateClaimTax: 80, impliedTax: 0, variance: 0 });
    expect(r.inputTax).toBe(275);
    expect(r.lateClaimInputTax).toBe(125);
    expect(r.inputVariance).toBe(0);
    expect(r.entriesWithoutBase).toEqual([]);
    expect(r.ties).toBe(true);
    expect(r.taxLegCount).toBe(3);
  });

  it('is exactly deriveVatBoxes when there is no companion', () => {
    const r = deriveVatBoxesWithLateClaims(bill);
    const plain = deriveVatBoxes(bill);
    expect(r).toEqual({
      ...plain,
      boxes: plain.boxes.map((b) => ({ ...b, lateClaimTax: 0 })),
      lateClaimInputTax: 0,
    });
  });

  it('a companion and its reversal in one period net to nothing', () => {
    const reversal = [vatIn('rev', 0, 80, 'capital_goods'), vatIn('rev', 0, 45), clearing('rev', 125, 0)];
    const r = deriveVatBoxesWithLateClaims([...bill, ...companion, ...reversal]);
    expect(r.lateClaimInputTax).toBe(0);
    expect(r.inputTax).toBe(150);
    expect(r.ties).toBe(true);
    expect(r.entriesWithoutBase).toEqual([]);
  });

  it('without the late-claim role the companion breaks box 15 (why the role exists)', () => {
    const r = deriveVatBoxes([...bill, ...companion]);
    // The clearing credit reads as a NEGATIVE base, so the check fails.
    expect(r.ties).toBe(false);
  });
});
