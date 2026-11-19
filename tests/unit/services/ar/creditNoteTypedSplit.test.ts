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
const note = (subtotal: number, taxAmount: number) => ({ subtotal, taxAmount, date: '2026-07-20' });
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
