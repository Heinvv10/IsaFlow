/**
 * Round 4, item 7 (ledger breaker): a credit note's VAT is capped by the VAT the invoice actually charged on the
 * rated net it reverses, not by the rate on its subtotal. The cap is the note's proportional share of the rated legs'
 * REMAINING VAT: allowed = round(remainingRatedVat x ratedPart / ratedLeft), 0 when either is 0, plus one cent. Line by
 * line the invoice's VAT may sit above the rate on its net (each R10.10 line's 1.515 rounds to 1.52), and the rate on
 * the subtotal refused its exact reversal, stranding the cents.
 */
import { describe, it, expect } from 'vitest';
import { CreditNoteVatSplitRefusal, allocateTypedCreditNote } from '@/modules/accounting/services/ar/creditNoteTypedSplit';
import type { RevenueLeg } from '@/modules/accounting/services/ar/invoiceRevenueLines';

const DEFAULT = 'acct-default-revenue';
const leg = (net: number, vatType: RevenueLeg['vatType'], id: string, taken = 0): RevenueLeg =>
  ({ glAccountId: DEFAULT, projectId: null, cc1Id: null, cc2Id: null, buId: null, net, vatType, journalLineId: id, taken });
const TEN_X_10_10 = [leg(101, 'standard', 's')]; // 10 lines of R10.10, each VAT 1.52: 15.20 on 101.00
const HUNDRED_X_0_10 = [leg(10, 'standard', 's'), leg(50, 'exempt', 'e')]; // VAT 2.00 on 10.00
const MIXED = [leg(1000, 'standard', 's'), leg(300, 'zero_rated', 'z'), leg(200, 'exempt', 'e')]; // VAT 150.00
// Ten R10.03 lines: 10.03 x 15% = 1.5045, each rounded DOWN to 1.50: 15.00 on 100.30, where 15% of 100.30 is 15.05.
const TEN_X_10_03_DOWN = [leg(100.3, 'standard', 's')];

const outcome = (legs: RevenueLeg[], remainingRatedVat: number, subtotal: number, taxAmount: number): string => {
  try {
    const { lines } = allocateTypedCreditNote(legs, { subtotal, taxAmount, date: '2026-07-20', remainingRatedVat }, 'CN-7', DEFAULT);
    return lines.map((l) => `${l.vatType} ${l.debit.toFixed(2)}`).join(', ');
  } catch (err) {
    if (err instanceof CreditNoteVatSplitRefusal) return `refused: ${err.message.replace('Credit note CN-7: ', '')}`;
    throw err;
  }
};

describe('the VAT cap is the note\'s share of the VAT the invoice charged', () => {
  it.each([
    ['10 x 10.10, full credit 101.00 + 15.20', TEN_X_10_10, 15.2, 101, 15.2, 'standard 101.00'],
    ['10 x 10.10, half 50.50 + 7.60', TEN_X_10_10, 15.2, 50.5, 7.6, 'standard 50.50'],
    ['100 x 0.10, rated-only 10.00 + 2.00', HUNDRED_X_0_10, 2, 10, 2, 'standard 10.00'],
    ['mixed, 100 + 15.01', MIXED, 150, 100, 15.01, 'standard 100.00'],
    ['rounded down, (b) half with the invoice\'s own VAT 50.15 + 7.50', TEN_X_10_03_DOWN, 15, 50.15, 7.5, 'standard 50.15'],
    ['rounded down, (c) full credit with the invoice\'s VAT 100.30 + 15.00', TEN_X_10_03_DOWN, 15, 100.3, 15, 'standard 100.30'],
  ] as const)('%s passes', (_label, legs, rem, sub, tax, expected) => {
    expect(outcome([...legs], rem, sub, tax)).toBe(expected);
  });

  it.each([
    ['mixed, 100 + 30', MIXED, 150, 100, 30,
      'refused: its VAT of 30.00 is more than the 15.00 of VAT the invoice charged on the 100.00 of standard-rated supplies it reverses. Correct its VAT.'],
    ['mixed, 100 + 15.02', MIXED, 150, 100, 15.02,
      'refused: its VAT of 15.02 is more than the 15.00 of VAT the invoice charged on the 100.00 of standard-rated supplies it reverses. Correct its VAT.'],
    ['100 x 0.10, 5.00 + 2.00 (allowed 1.00 on 5.00 of 10.00)', HUNDRED_X_0_10, 2, 5, 2,
      'refused: its VAT of 2.00 is more than the 1.00 of VAT the invoice charged on the 5.00 of standard-rated supplies it reverses. Correct its VAT.'],
    ['rounded down, (a) half at the rate 50.15 + 7.52', TEN_X_10_03_DOWN, 15, 50.15, 7.52,
      'refused: its VAT of 7.52 is more than the 7.50 of VAT the invoice charged on the 50.15 of standard-rated supplies it reverses. Correct its VAT.'],
    ['rounded down, (d) full credit at the rate 100.30 + 15.05', TEN_X_10_03_DOWN, 15, 100.3, 15.05,
      'refused: its VAT of 15.05 is more than the 15.00 of VAT the invoice charged on the 100.30 of standard-rated supplies it reverses. Correct its VAT.'],
    ['mixed, 1100 + 165 (over-allocation)', MIXED, 150, 1100, 165,
      'refused: its VAT of 165.00 is VAT on 1100.00 of standard-rated supplies, but the invoice\'s rated lines have 1000.00 left to credit (100.00 over). Reduce the note, or its VAT.'],
  ] as const)('%s is refused', (_label, legs, rem, sub, tax, expected) => {
    expect(outcome([...legs], rem, sub, tax)).toBe(expected);
  });

  it('a zero-VAT note needs no rate lookup', () => {
    expect(allocateTypedCreditNote(MIXED, { subtotal: 200, taxAmount: 0, date: '1980-01-01', remainingRatedVat: 150 }, 'CN-7', DEFAULT)
      .lines.map((l) => [l.vatType, l.debit])).toEqual([['zero_rated', 120], ['exempt', 80]]);
  });
});

// The breaker's two cent-level residues (folded into item 5). Each note's VAT is held to its share of the remaining
// VAT within one cent, and its rated net follows its VAT within one cent, so VAT and rated net can drift apart by at
// most ONE CENT PER NOTE; the residues below need that drift accumulated over many notes.
describe('cent-level residues', () => {
  it('(a) 10.00 of rated net left with 0.01 of VAT: a 10 + 0.01 note takes the net (unchanged by the share cap)', () => {
    expect(outcome([leg(10, 'standard', 's')], 0.01, 10, 0.01)).toBe('standard 10.00');
  });

  it('(b) rated net used up, 0.10 of VAT left: a 10 + 0.10 note is now refused (no rated net to carry VAT)', () => {
    expect(outcome([leg(100, 'standard', 's', 100), leg(50, 'exempt', 'e')], 0.1, 10, 0.1))
      .toBe('refused: its VAT of 0.10 is more than the 0.00 of VAT the invoice charged on the 0.00 of standard-rated supplies it reverses. Correct its VAT.');
  });

  it('(b) a single cent of such residue still passes, so one note\'s drift is always reversible', () => {
    expect(outcome([leg(100, 'standard', 's', 100), leg(50, 'exempt', 'e')], 0.01, 10, 0.01)).toBe('exempt 10.00');
  });
});

// Round 4 follow-up: partial notes against line-rounded VAT, both directions.
describe('partial notes against VAT the lines rounded', () => {
  it('ten R10.10 lines: a first note at the rate (50.50 + 7.58) leaves 7.62, which the final 50.50 takes', () => {
    expect(outcome(TEN_X_10_10, 15.2, 50.5, 7.58)).toBe('standard 50.50');
    // What remains: 50.50 of net, 15.20 - 7.58 = 7.62 of VAT; the final note reverses all of it.
    expect(outcome([leg(101, 'standard', 's', 50.5)], 7.62, 50.5, 7.62)).toBe('standard 50.50');
  });

  // Ten R10.03 lines each carry 1.50 (1.5045 rounded DOWN): 15.00 on 100.30. The invoice charged 7.50 on 50.15 of it,
  // so a note at the standard rate on 50.15 (7.52) asks back VAT the invoice never charged: refused, naming 7.50.
  const TEN_X_10_03 = [leg(100.3, 'standard', 's')];
  it('lines that rounded down: a note at exactly the rate is refused, the message naming the VAT the invoice charged', () => {
    expect(outcome(TEN_X_10_03, 15, 50.15, 7.52)).toBe('refused: its VAT of 7.52 is more than the 7.50 of VAT the invoice '
      + 'charged on the 50.15 of standard-rated supplies it reverses. Correct its VAT.');
    expect(outcome(TEN_X_10_03, 15, 50.15, 7.5)).toBe('standard 50.15');
  });
});
