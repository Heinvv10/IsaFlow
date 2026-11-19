/**
 * A customer credit note linked to a TYPED invoice (every revenue leg of its journal coded, migration 1008): the note's
 * VAT decides how much of its subtotal is rated. The rated part (the net its tax_amount is VAT on, at the standard rate
 * on the note's date, reconciled to the subtotal within a cent) is taken pro rata from the invoice's remaining RATED
 * legs only, the rest from its remaining UNRATED legs only; a part the legs cannot carry is refused before any write.
 * PR #1648 review L3: pro rata over every leg reversed 30 of VAT against 133.33 of standard net (the 15% check out by
 * R10). A note against a legacy invoice (uncoded legs) is untouched: creditNoteVatTypedLegs / invoiceRevenueLines.
 */
import { describe, it, expect } from 'vitest';
import {
  CreditNoteVatSplitRefusal, allocateTypedCreditNote, legsAreTyped, noteRatedCents,
} from '@/modules/accounting/services/ar/creditNoteTypedSplit';
import type { RevenueLeg } from '@/modules/accounting/services/ar/invoiceRevenueLines';
import { validateJournalEntry } from '@/modules/accounting/utils/doubleEntry';

const DEFAULT = 'acct-default-revenue';
const leg = (net: number, vatType: RevenueLeg['vatType'], id: string, taken = 0): RevenueLeg =>
  ({ glAccountId: DEFAULT, projectId: null, cc1Id: null, cc2Id: null, buId: null, net, vatType, journalLineId: id, taken });
const MIXED = [leg(1000, 'standard', 's'), leg(300, 'zero_rated', 'z'), leg(200, 'exempt', 'e')];
/** A note against MIXED (or a 1000-standard invoice), whose rated legs still carry all 150.00 of their VAT. */
const note = (subtotal: number, taxAmount: number) => ({ subtotal, taxAmount, date: '2026-07-20', remainingRatedVat: 150 });
const debits = (legs: RevenueLeg[], subtotal: number, taxAmount: number) =>
  allocateTypedCreditNote(legs, note(subtotal, taxAmount), 'CN-9', DEFAULT).lines.map((l) => [l.vatType, l.debit]);

describe('noteRatedCents', () => {
  it('is the net the VAT is on, reconciled to the subtotal within a cent', () => {
    expect(noteRatedCents(note(200, 30))).toBe(20000);
    expect(noteRatedCents(note(300, 15))).toBe(10000);
    expect(noteRatedCents(note(200, 0))).toBe(0);
    expect(noteRatedCents(note(8.7, 1.3))).toBe(870); // a dispute's gross 10.00 split 8.70 + 1.30: 15% of 8.70 is 1.305
    expect(noteRatedCents(note(100, 20))).toBe(10000); // never more than the subtotal
  });

  it('reads the standard rate on the note\'s date', () => {
    expect(noteRatedCents({ subtotal: 200, taxAmount: 14, date: '2017-06-30' })).toBe(10000);
  });
});

describe('allocateTypedCreditNote', () => {
  it('a note of 200 + VAT 30 against 1000 standard / 300 zero / 200 exempt debits standard 200 only', () => {
    const { lines, allocations } = allocateTypedCreditNote(MIXED, note(200, 30), 'CN-9', DEFAULT);
    expect(lines.map((l) => [l.vatType, l.debit])).toEqual([['standard', 200]]);
    expect(allocations.map((a) => [a.journalLineId, a.amount, a.isExcess])).toEqual([['s', 200, false]]);
    expect(validateJournalEntry([...lines, { glAccountId: 'vat', debit: 30, credit: 0 },
      { glAccountId: 'ar', debit: 0, credit: 230 }]).valid).toBe(true);
  });

  it('a note of 200 with no VAT debits zero-rated and exempt only, pro rata (120 / 80)', () => {
    expect(debits(MIXED, 200, 0)).toEqual([['zero_rated', 120], ['exempt', 80]]);
  });

  it('a note with VAT on part of it (300, VAT 15) debits 100 standard and 200 across zero-rated and exempt', () => {
    expect(debits(MIXED, 300, 15)).toEqual([['standard', 100], ['zero_rated', 120], ['exempt', 80]]);
  });

  it('takes from what each group has left after earlier notes', () => {
    const taken = [leg(1000, 'standard', 's', 900), leg(300, 'zero_rated', 'z', 0), leg(200, 'exempt', 'e', 200)];
    expect(debits(taken, 400, 15)).toEqual([['standard', 100], ['zero_rated', 300]]);
  });

  it('refuses a note whose VAT implies more rated net than the rated legs have left, saying by how much', () => {
    const err = (() => { try { allocateTypedCreditNote(MIXED, note(1100, 165), 'CN-9', DEFAULT); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(CreditNoteVatSplitRefusal);
    expect((err as Error).message).toBe('Credit note CN-9: its VAT of 165.00 is VAT on 1100.00 of standard-rated supplies, '
      + 'but the invoice\'s rated lines have 1000.00 left to credit (100.00 over). Reduce the note, or its VAT.');
  });

  it('refuses a note whose untaxed part is more than the zero-rated and exempt legs have left', () => {
    expect(() => allocateTypedCreditNote(MIXED, note(600, 0), 'CN-9', DEFAULT))
      .toThrow('Credit note CN-9: 600.00 of it carries no VAT, but the invoice\'s zero-rated and exempt lines have 500.00 '
        + 'left to credit (100.00 over). Give the note its VAT, or reduce it.');
    expect(() => allocateTypedCreditNote([leg(1000, 'standard', 's')], note(115, 15), 'CN-9', DEFAULT))
      .toThrow(/15\.00 of it carries no VAT, but the invoice's zero-rated and exempt lines have 0\.00 left/);
  });
});

describe('legsAreTyped', () => {
  it('every leg coded: typed; any uncoded leg, or none at all: not', () => {
    expect(legsAreTyped(MIXED)).toBe(true);
    expect(legsAreTyped([leg(1000, 'standard', 's'), leg(300, null, 'z')])).toBe(false);
    expect(legsAreTyped([])).toBe(false);
  });
});

// PR #1648 review round 3, item 2: a full credit of a mixed typed invoice is not refused by a rounding cent. When the
// note's VAT is (within a cent) all the VAT the invoice's rated legs still carry, its rated part IS their remaining net.
describe('a note reversing all the remaining rated VAT', () => {
  const full = (legs: RevenueLeg[], subtotal: number, taxAmount: number, remainingRatedVat: number) =>
    allocateTypedCreditNote(legs, { subtotal, taxAmount, date: '2026-07-20', remainingRatedVat }, 'CN-9', DEFAULT)
      .lines.map((l) => [l.vatType, l.debit]);

  it('66.66 standard (VAT 10.00) + 100 exempt: a 166.66 + 10.00 note takes each leg\'s remaining balance', () => {
    expect(full([leg(66.66, 'standard', 's'), leg(100, 'exempt', 'e')], 166.66, 10, 10)).toEqual([['standard', 66.66], ['exempt', 100]]);
  });

  it('100 lines of R0.10 standard (VAT 2.00) + 50 exempt: a 60.00 + 2.00 note takes 10.00 and 50.00', () => {
    expect(full([leg(10, 'standard', 's'), leg(50, 'exempt', 'e')], 60, 2, 2)).toEqual([['standard', 10], ['exempt', 50]]);
  });

  it('a partial note at the rate, then a final note that clears the invoice exactly', () => {
    const first = allocateTypedCreditNote([leg(66.66, 'standard', 's'), leg(100, 'exempt', 'e')],
      { subtotal: 33.33, taxAmount: 5, date: '2026-07-20', remainingRatedVat: 10 }, 'CN-1', DEFAULT);
    expect(first.lines.map((l) => [l.vatType, l.debit])).toEqual([['standard', 33.33]]);
    const after = [leg(66.66, 'standard', 's', 33.33), leg(100, 'exempt', 'e')];
    const last = allocateTypedCreditNote(after, { subtotal: 133.33, taxAmount: 5, date: '2026-07-25', remainingRatedVat: 5 }, 'CN-2', DEFAULT);
    expect(last.lines.map((l) => [l.vatType, l.debit])).toEqual([['standard', 33.33], ['exempt', 100]]);
    expect(last.allocations.filter((a) => a.isExcess)).toEqual([]);
  });

  it('the same on the hundred-line invoice: 5.00 + 0.75, then 55.00 + 1.25 clears it', () => {
    expect(full([leg(10, 'standard', 's'), leg(50, 'exempt', 'e')], 5, 0.75, 2)).toEqual([['standard', 5]]);
    expect(full([leg(10, 'standard', 's', 5), leg(50, 'exempt', 'e')], 55, 1.25, 1.25)).toEqual([['standard', 5], ['exempt', 50]]);
  });

  it('still refuses a genuine over-allocation: 1100 + 165 against 1000 rated carrying 150', () => {
    expect(() => full(MIXED, 1100, 165, 150)).toThrow(/1100\.00 of standard-rated supplies, but the invoice's rated lines have 1000\.00 left/);
  });

  it('cannot move net between groups: the rated part is the rated legs\' own remaining net, the rest must fit the unrated', () => {
    // VAT equal to all of it, but a subtotal too large for the unrated legs: refused, not stretched.
    expect(() => full(MIXED, 1600, 150, 150)).toThrow(/600\.00 of it carries no VAT, but the invoice's zero-rated and exempt lines have 500\.00/);
  });
});

// Item 3: a note's VAT may not exceed the standard rate on its subtotal (a cent over allowed), on the typed path.
describe('a note whose VAT is more than its subtotal can carry', () => {
  const run = (subtotal: number, taxAmount: number) =>
    allocateTypedCreditNote(MIXED, { subtotal, taxAmount, date: '2026-07-20', remainingRatedVat: 150 }, 'CN-9', DEFAULT);

  it('refuses 100 + VAT 30, giving both figures', () => {
    expect(() => run(100, 30)).toThrow(new CreditNoteVatSplitRefusal('Credit note CN-9: its VAT of 30.00 is more than the '
      + '15.00 of VAT the invoice charged on the 100.00 of standard-rated supplies it reverses. Correct its VAT.'));
  });

  it('accepts VAT exactly at the rate, and a cent over; refuses two cents over', () => {
    expect(run(100, 15).lines.map((l) => [l.vatType, l.debit])).toEqual([['standard', 100]]);
    expect(() => run(100, 15.01)).not.toThrow();
    expect(() => run(100, 15.02)).toThrow(/its VAT of 15\.02 is more than the 15\.00 of VAT the invoice charged on the 100\.00/);
  });
});

// Round 4, item 5: the "all remaining VAT" branch when the rated legs have (almost) no VAT left. Reachable: a note at
// the rate whose VAT rounds up (99.99 + VAT 15.00 against 100 standard) takes 99.99 of net and all 15.00 of VAT,
// leaving 0.01 of rated net with no VAT. A later note carrying a cent of VAT then takes that last cent of net, which
// is exactly what the rated legs hold: net and VAT both end at zero. A large rated net with no VAT left cannot arise
// from these rules (each note's rated part follows its VAT, to a cent), and if it ever did, the note would reverse what
// the legs hold rather than leave it stranded.
describe('the rated legs with no VAT left', () => {
  it('a note with a cent of VAT takes the last cent of rated net, the rest from the unrated legs', () => {
    const legs = [leg(100, 'standard', 's', 99.99), leg(200, 'exempt', 'e')];
    const out = allocateTypedCreditNote(legs, { subtotal: 50.01, taxAmount: 0.01, date: '2026-07-20', remainingRatedVat: 0 }, 'CN-9', DEFAULT);
    expect(out.lines.map((l) => [l.vatType, l.debit])).toEqual([['standard', 0.01], ['exempt', 50]]);
  });
});

// Round 4, item 6: a zero-VAT note needs no rate; a note WITH VAT on a date no rate can be read for is a refusal, not a 500.
describe('a note dated where no VAT rate can be read', () => {
  it('a zero-VAT note posts to the unrated legs without reading a rate', () => {
    const out = allocateTypedCreditNote(MIXED, { subtotal: 200, taxAmount: 0, date: '1980-01-01', remainingRatedVat: 150 }, 'CN-9', DEFAULT);
    expect(out.lines.map((l) => [l.vatType, l.debit])).toEqual([['zero_rated', 120], ['exempt', 80]]);
  });

  it('a note with VAT is refused with the refusal class, naming the date', () => {
    expect(() => allocateTypedCreditNote(MIXED, { subtotal: 200, taxAmount: 30, date: '1980-01-01', remainingRatedVat: 150 }, 'CN-9', DEFAULT))
      .toThrow(new CreditNoteVatSplitRefusal('Credit note CN-9: its date cannot be read for a VAT rate '
        + '(1980-01-01 is before VAT began (1991-09-30)).'));
  });
});

// Round 4 (found by the item 1 tests): the cap on a note's VAT (item 3) must not refuse the exact reversal of a
// rated group whose VAT was rounded up line by line: a hundred R0.10 standard lines carry 2.00 of VAT on 10.00.
describe('the VAT cap and a full reversal of per-line-rounded VAT', () => {
  const hundredLines = [leg(10, 'standard', 's'), leg(50, 'exempt', 'e')];
  it('a 10.00 + 2.00 note reversing all of the standard lines is not refused', () => {
    const out = allocateTypedCreditNote(hundredLines, { subtotal: 10, taxAmount: 2, date: '2026-07-20', remainingRatedVat: 2 }, 'CN-9', DEFAULT);
    expect(out.lines.map((l) => [l.vatType, l.debit])).toEqual([['standard', 10]]);
  });

  it('a 5.00 + 2.00 note (all the VAT on half the net) is still refused by the cap', () => {
    expect(() => allocateTypedCreditNote(hundredLines, { subtotal: 5, taxAmount: 2, date: '2026-07-20', remainingRatedVat: 2 }, 'CN-9', DEFAULT))
      .toThrow(/its VAT of 2\.00 is more than the 1\.00 of VAT the invoice charged on the 5\.00 of standard-rated supplies/);
  });
});
