/**
 * A customer credit note against a TYPED invoice is PROPORTIONAL ONLY (Hein, 2026-11-19): its debits are spread pro
 * rata over every revenue leg by remaining net, and its VAT must be exactly the invoice's remaining VAT in proportion
 * (all of it when the note clears the net). The real functions; sequences are simulated by feeding each note's
 * allocation rows back as `taken` and its tax out of the remaining VAT, as the reader does.
 */
import { describe, it, expect } from 'vitest';
import {
  CreditNoteVatSplitRefusal, allocateTypedCreditNote, legsAreTyped, requiredCreditNoteVat, splitGrossProportionally,
} from '@/modules/accounting/services/ar/creditNoteTypedSplit';
import type { RevenueLeg } from '@/modules/accounting/services/ar/invoiceRevenueLines';
import { validateJournalEntry } from '@/modules/accounting/utils/doubleEntry';

const DEFAULT = 'acct-default-revenue';
const leg = (net: number, vatType: RevenueLeg['vatType'], id: string, taken = 0): RevenueLeg =>
  ({ glAccountId: DEFAULT, projectId: null, cc1Id: null, cc2Id: null, buId: null, net, vatType, journalLineId: id, taken });
const MIXED = () => [leg(1000, 'standard', 's'), leg(300, 'zero_rated', 'z'), leg(200, 'exempt', 'e')]; // VAT 150
const TEN_X_10_10 = () => [leg(101, 'standard', 's')]; // each 1.515 -> 1.52: VAT 15.20
const TEN_X_10_03 = () => [leg(100.3, 'standard', 's')]; // each 1.5045 -> 1.50: VAT 15.00
const HUNDRED = () => [leg(10, 'standard', 's'), leg(50, 'exempt', 'e')]; // each 0.015 -> 0.02: VAT 2.00

const c = (n: number) => Math.round(n * 100);
type Outcome = string;
const run = (legs: RevenueLeg[], remainingVat: number, subtotal: number, taxAmount: number): Outcome => {
  try {
    return allocateTypedCreditNote(legs, { subtotal, taxAmount, remainingVat }, 'CN-9', DEFAULT)
      .lines.map((l) => `${l.vatType} ${l.debit.toFixed(2)}`).join(', ');
  } catch (err) {
    if (err instanceof CreditNoteVatSplitRefusal) return `refused: ${err.message}`;
    throw err;
  }
};

/** An invoice's state across notes: legs (with taken) and remaining VAT (cents). */
class Invoice {
  constructor(public legs: RevenueLeg[], public vat: number, readonly originalVat = vat) {}
  get remainingNet(): number { return this.legs.reduce((s, l) => s + c(l.net) - c(l.taken ?? 0), 0); }
  required(subtotalCents: number): number {
    return c(requiredCreditNoteVat({ remainingNet: this.remainingNet / 100, remainingVat: this.vat / 100, subtotal: subtotalCents / 100 }));
  }
  /** Approve a note of `subtotalCents` with the required VAT; returns its tax (cents) and checks its journal. */
  credit(subtotalCents: number): number {
    const tax = this.required(subtotalCents);
    const out = allocateTypedCreditNote(this.legs, { subtotal: subtotalCents / 100, taxAmount: tax / 100, remainingVat: this.vat / 100 }, 'CN', DEFAULT);
    expect(out.lines.reduce((s, l) => s + c(l.debit) - c(l.credit), 0)).toBe(subtotalCents);
    // As approveCreditNote posts it: a VAT reversal only when there is VAT.
    const vatLeg = tax > 0 ? [{ glAccountId: 'vat', debit: tax / 100, credit: 0 }] : [];
    expect(validateJournalEntry([...out.lines, ...vatLeg,
      { glAccountId: 'ar', debit: 0, credit: (subtotalCents + tax) / 100 }]).valid).toBe(true);
    for (const a of out.allocations) {
      const l = this.legs.find((x) => x.journalLineId === a.journalLineId)!;
      l.taken = (c(l.taken ?? 0) + c(a.amount)) / 100;
      expect(Math.abs(c(l.taken)) <= Math.abs(c(l.net))).toBe(true); // never over-credited
    }
    this.vat -= tax;
    expect(this.vat).toBeGreaterThanOrEqual(0);
    expect(this.originalVat - this.vat).toBeLessThanOrEqual(this.originalVat);
    return tax;
  }
}

describe('requiredCreditNoteVat', () => {
  it('all the VAT when the note clears the net; else the proportional share, half away from zero', () => {
    expect(requiredCreditNoteVat({ remainingNet: 1500, remainingVat: 150, subtotal: 150 })).toBe(15);
    expect(requiredCreditNoteVat({ remainingNet: 1500, remainingVat: 150, subtotal: 1500 })).toBe(150);
    expect(requiredCreditNoteVat({ remainingNet: 101, remainingVat: 15.2, subtotal: 50.5 })).toBe(7.6);
    expect(requiredCreditNoteVat({ remainingNet: 100.3, remainingVat: 15, subtotal: 50.15 })).toBe(7.5);
    expect(requiredCreditNoteVat({ remainingNet: 1, remainingVat: 0.01, subtotal: 0.5 })).toBe(0.01); // 0.005 -> 0.01
    expect(requiredCreditNoteVat({ remainingNet: 50.5, remainingVat: 7.62, subtotal: 50.5 })).toBe(7.62);
  });

  // V x S in cents passes 2^53 above ~R2.4M; a float product then rounds the cent wrong (here 2 622 922.09).
  it('exact in integer cents at any size: an R18.5M invoice', () => {
    expect(requiredCreditNoteVat({ remainingNet: 18563987.4, remainingVat: 2784598.11, subtotal: 17486147.3 })).toBe(2622922.1);
    expect(requiredCreditNoteVat({ remainingNet: 26189978.4, remainingVat: 3928496.76, subtotal: 3930755.5 })).toBe(589613.33);
  });

  // No S = R special case: the formula itself gives all of V, at any size and whatever V / R is.
  it.each([
    [1500, 150], [101, 15.2], [0.01, 0.01], [26189978.4, 3928496.76], [999999999.99, 150000000], [0.03, 0],
  ])('a note crediting all %s of the net carries all %s of the VAT', (r, v) =>
    expect(requiredCreditNoteVat({ remainingNet: r, remainingVat: v, subtotal: r })).toBe(v));
});

describe('the proportional rule, case by case', () => {
  it.each([
    ['mixed: 150 + 15.00 debits 100 / 30 / 20', MIXED(), 150, 150, 15, 'standard 100.00, zero_rated 30.00, exempt 20.00'],
    ['mixed: full credit 1500 + 150 clears every leg', MIXED(), 150, 1500, 150, 'standard 1000.00, zero_rated 300.00, exempt 200.00'],
    ['ten x 10.10: 50.50 + 7.60', TEN_X_10_10(), 15.2, 50.5, 7.6, 'standard 50.50'],
    ['ten x 10.03: 50.15 + 7.50', TEN_X_10_03(), 15, 50.15, 7.5, 'standard 50.15'],
  ] as const)('%s passes', (_l, legs, vat, sub, tax, expected) => expect(run([...legs], vat, sub, tax)).toBe(expected));

  it.each([
    ['mixed: 150 + 22.50 (15% of 150)', MIXED(), 150, 150, 22.5,
      'Credit note CN-9 reverses 150.00 of an invoice with 1500.00 left, so its VAT must be 15.00, not 22.50. '
      + 'An invoice with a VAT type per line is credited in proportion across its lines.'],
    ['ten x 10.10: 50.50 + 7.58 (the rate on 50.50)', TEN_X_10_10(), 15.2, 50.5, 7.58,
      'Credit note CN-9 reverses 50.50 of an invoice with 101.00 left, so its VAT must be 7.60, not 7.58. '
      + 'An invoice with a VAT type per line is credited in proportion across its lines.'],
    ['ten x 10.03: 50.15 + 7.52', TEN_X_10_03(), 15, 50.15, 7.52,
      'Credit note CN-9 reverses 50.15 of an invoice with 100.30 left, so its VAT must be 7.50, not 7.52. '
      + 'An invoice with a VAT type per line is credited in proportion across its lines.'],
    ['ten x 10.10: 50.50 + 7.59 (one cent under)', TEN_X_10_10(), 15.2, 50.5, 7.59,
      'Credit note CN-9 reverses 50.50 of an invoice with 101.00 left, so its VAT must be 7.60, not 7.59. '
      + 'An invoice with a VAT type per line is credited in proportion across its lines.'],
    ['ten x 10.10: 101.00 + 15.21 (clearing, one cent over)', TEN_X_10_10(), 15.2, 101, 15.21,
      'Credit note CN-9 reverses 101.00 of an invoice with 101.00 left, so its VAT must be 15.20, not 15.21. '
      + 'An invoice with a VAT type per line is credited in proportion across its lines.'],
    ['mixed: more than is left, 1600 + 160', MIXED(), 150, 1600, 160,
      'Credit note CN-9 credits 1600.00, but the invoice has 1500.00 left to credit. Reduce the note.'],
    ['a zero subtotal', MIXED(), 150, 0, 0, 'Credit note CN-9 credits 0.00, but the invoice has 1500.00 left to credit. Reduce the note.'],
    ['negative VAT left (hand-made data)', MIXED(), -1, 150, 0,
      'Credit note CN-9 cannot be raised: the invoice\'s VAT is already fully reversed. Correct it with a journal.'],
  ] as const)('%s is refused, naming the figure', (_l, legs, vat, sub, tax, message) =>
    expect(run([...legs], vat, sub, tax)).toBe(`refused: ${message}`));

  it('ten x 10.10: two notes of 50.50 + 7.60 clear it to net 0 / VAT 0', () => {
    const inv = new Invoice(TEN_X_10_10(), 1520);
    expect([inv.credit(5050), inv.credit(5050)]).toEqual([760, 760]);
    expect([inv.remainingNet, inv.vat]).toEqual([0, 0]);
  });

  it('a hundred R0.10 lines + 50 exempt: 20 + required, 20 + required, then the remainder end at net 0 / VAT 0', () => {
    const inv = new Invoice(HUNDRED(), 200);
    expect([inv.credit(2000), inv.credit(2000), inv.credit(inv.remainingNet)]).toEqual([67, 67, 66]);
    expect([inv.remainingNet, inv.vat, ...inv.legs.map((l) => c(l.net) - c(l.taken ?? 0))]).toEqual([0, 0, 0, 0]);
  });

  it('the breaker\'s case cannot happen: after 50.50 + 7.58 is refused, nothing strands', () => {
    expect(run(TEN_X_10_10(), 15.2, 50.5, 7.58)).toMatch(/^refused: .*must be 7\.60, not 7\.58/);
  });
});

// Property: random-but-seeded invoices and splits; every sequence of notes carrying the required VAT ends at net 0 and
// VAT 0, with no leg over-credited, each note's debits equal to its subtotal, and VAT reversed never above the invoice's.
describe('any sequence of notes with the required VAT clears the invoice exactly', () => {
  let seed = 20261119;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const lineVat = (netCents: number) => Math.round(netCents * 0.15); // a rated line's own VAT, rounded on the line
  const invoices: Array<[string, () => { legs: RevenueLeg[]; vat: number }]> = [
    ['lines rounding up (ten x 10.10)', () => ({ legs: TEN_X_10_10(), vat: 1520 })],
    ['lines rounding down (ten x 10.03)', () => ({ legs: TEN_X_10_03(), vat: 1500 })],
    ['mixed with zero-rated and exempt', () => ({ legs: MIXED(), vat: 15000 })],
    ['a hundred R0.10 lines + exempt', () => ({ legs: HUNDRED(), vat: 200 })],
    ['a negative rated leg (a discount line)', () => ({
      legs: [leg(500, 'standard', 's'), leg(-40, 'standard', 'd'), leg(120.33, 'exempt', 'e')], vat: lineVat(50000) + lineVat(-4000),
    })],
  ];
  it.each(invoices)('%s', (_label, make) => {
    for (let trial = 0; trial < 40; trial++) {
      const { legs, vat } = make();
      const inv = new Invoice(legs, vat);
      const k = 1 + Math.floor(rand() * 5);
      for (let n = 1; n < k && inv.remainingNet > 1; n++) inv.credit(1 + Math.floor(rand() * (inv.remainingNet - 1)));
      inv.credit(inv.remainingNet); // the note that clears it: always accepted, with all the VAT left
      expect([inv.remainingNet, inv.vat]).toEqual([0, 0]);
      for (const l of inv.legs) expect(c(l.net) - c(l.taken ?? 0)).toBe(0);
    }
  });
});

describe('splitGrossProportionally (dispute notes)', () => {
  it('splits a gross into a subtotal and its required VAT, adding up exactly', () => {
    expect(splitGrossProportionally(165, 1500, 150)).toEqual({ subtotal: 150, taxAmount: 15 });
    const half = splitGrossProportionally(58.1, 101, 15.2)!;
    expect(half).toEqual({ subtotal: 50.5, taxAmount: 7.6 });
  });
  it('null when the gross is more than the invoice has left', () => {
    expect(splitGrossProportionally(2000, 1500, 150)).toBeNull();
  });
});

describe('legsAreTyped', () => {
  it('every leg coded: typed; any uncoded leg, or none at all: not', () => {
    expect(legsAreTyped(MIXED())).toBe(true);
    expect(legsAreTyped([leg(1000, 'standard', 's'), leg(300, null, 'z')])).toBe(false);
    expect(legsAreTyped([])).toBe(false);
  });
});
