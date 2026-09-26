/**
 * A late-claim companion (DR VAT Input / CR "Input VAT - late claims") has no
 * base LEG — its supply was recorded in the locked period, on the original —
 * but each VAT Input line CARRIES the base behind its claim (late_claim_base,
 * derived from the original as the VAT201 would have). The claim period's 15%
 * check counts that base, so a late claim faces exactly the check it would have
 * faced on time: an over-claim shows as variance, and a companion is never an
 * entry without base.
 */
import { describe, expect, it } from 'vitest';
import { deriveVatBoxes, type VatLineInput } from '@/modules/accounting/services/reports/vatBoxBasis';
import { deriveVatBoxesWithLateClaims, type LateClaimAwareLine } from '@/modules/accounting/services/reports/vatLateClaimBasis';

let n = 0;
const line = (je: string, over: Partial<LateClaimAwareLine>): LateClaimAwareLine => ({
  journalEntryId: je, entryNumber: je, entryDate: '2026-09-10', lineId: `l${++n}`,
  accountId: 'a', accountCode: '0', accountName: 'x', accountType: 'expense',
  accountSubtype: 'operating_expense', vatType: null, debit: 0, credit: 0, cancelledSource: false,
  // The late-claim companion is recognised by its SOURCE (and so is its reversal, which copies it).
  entrySource: je === 'comp' || je === 'rev' ? 'auto_vat_late_claim' : 'manual',
  ...over,
});
const vatIn = (je: string, debit: number, credit = 0, vatType = 'standard', lateClaimBase?: number) =>
  line(je, { accountId: 'vin', accountType: 'asset', accountSubtype: 'vat_input', vatType, debit, credit, lateClaimBase });
const clearing = (je: string, debit: number, credit: number) =>
  line(je, { accountId: 'clr', accountType: 'asset', accountSubtype: 'vat_input_late_claim', debit, credit });

// An ordinary bill in the claim period: base 1000, tax 150.
const bill = [
  line('bill', { debit: 1000 }),
  vatIn('bill', 150),
  line('bill', { accountId: 'ap', accountType: 'liability', accountSubtype: 'payable', credit: 1150 }),
];
// The companion of a bill dated in a locked period: 80 of capital-goods tax, 45 standard.
const companion = [vatIn('comp', 80, 0, 'capital_goods', 533.33), vatIn('comp', 45, 0, 'standard', 300), clearing('comp', 0, 125)];

describe('deriveVatBoxesWithLateClaims', () => {
  it('adds the companion tax AND the base behind it to its boxes; the base check ties', () => {
    const r = deriveVatBoxesWithLateClaims([...bill, ...companion]);
    const std = r.boxes.find((b) => b.direction === 'input' && b.vatType === 'standard')!;
    const cap = r.boxes.find((b) => b.direction === 'input' && b.vatType === 'capital_goods')!;
    expect(std).toMatchObject({ base: 1300, tax: 195, lateClaimTax: 45, impliedTax: 195, variance: 0 });
    expect(cap).toMatchObject({ base: 533.33, tax: 80, lateClaimTax: 80, impliedTax: 80, variance: 0 });
    expect(r.inputBase).toBe(1833.33);
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
    const reversal = [vatIn('rev', 0, 80, 'capital_goods', -533.33), vatIn('rev', 0, 45, 'standard', -300), clearing('rev', 125, 0)];
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

  it('a hand-made DR VAT Input / CR clearing journal is NOT a late claim: it is flagged as having no base', () => {
    const fake = [vatIn('fake', 30), clearing('fake', 0, 30)];
    const r = deriveVatBoxesWithLateClaims([...bill, ...fake]);
    expect(r.lateClaimInputTax).toBe(0);
    expect(r.entriesWithoutBase).toContain('fake');
    expect(r.ties).toBe(false);
  });

  it('output tax is never lateClaimTax: a companion-sourced journal with an output leg is an ordinary journal', () => {
    const sale = [
      line('comp', { accountId: 'bank', accountType: 'asset', accountSubtype: 'bank', debit: 1149.99 }),
      clearing('comp', 0.01, 0),
      line('comp', { accountType: 'revenue', accountSubtype: 'default_revenue', vatType: 'standard', credit: 1000 }),
      line('comp', { accountId: 'vout', accountType: 'liability', accountSubtype: 'vat_output', vatType: 'standard', credit: 150 }),
    ];
    const r = deriveVatBoxesWithLateClaims(sale);
    const box1 = r.boxes.find((b) => b.direction === 'output' && b.vatType === 'standard')!;
    // Ordinary in EVERY respect, the clearing cent included: it stays a base line, as in any journal
    // with an output leg, so the discrepancy shows (999.99) instead of being smoothed to 1 000.
    expect(box1).toMatchObject({ base: 999.99, tax: 150, lateClaimTax: 0 });
    expect(r.outputTax).toBe(150);
    expect(r.lateClaimInputTax).toBe(0);
  });

  it('an over-claim shows as variance in the claim period, exactly as on time', () => {
    const lateOver = [vatIn('comp', 16, 0, 'standard', 100), clearing('comp', 0, 16)];
    const onTime = [line('ot', { debit: 100 }), vatIn('ot', 16), line('ot', { accountId: 'ap', accountType: 'liability', accountSubtype: 'payable', credit: 116 })];
    const late = deriveVatBoxesWithLateClaims(lateOver);
    const now = deriveVatBoxesWithLateClaims(onTime);
    // R1 raw over-claim. A single taxed input-VAT line's rounding allowance
    // is now R0.005 (item 9, 2026-09-26), which cannot survive rounding to
    // the cent, so the full R1 shows on both sides — no rounding-allowance
    // reduction for a single-line claim.
    expect(late.inputVariance).toBe(1);
    expect(late.inputVariance).toBe(now.inputVariance);
    expect(late.inputBase).toBe(now.inputBase);
  });

  it('a companion line with no recorded base is listed as an entry without base', () => {
    const r = deriveVatBoxesWithLateClaims([vatIn('comp', 15), clearing('comp', 0, 15)]);
    expect(r.entriesWithoutBase).toEqual(['comp']);
    expect(r.ties).toBe(false);
  });
});
