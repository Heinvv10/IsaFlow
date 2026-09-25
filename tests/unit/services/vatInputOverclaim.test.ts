/**
 * Per-journal input over-claim (reports/vatInputOverclaim): the input variance
 * the VAT201 rate check gates on is Σ max(0, tax − rate·base) PER JOURNAL, so an
 * under-claim on one bill can no longer absorb an over-claim on another.
 */
import { describe, expect, it } from 'vitest';
import {
  perJournalInputOverclaim, type OverclaimLine,
} from '@/modules/accounting/services/reports/vatInputOverclaim';

const RATE = 0.15;
let n = 0;
const line = (je: string, over: Partial<OverclaimLine>): OverclaimLine => ({
  journalEntryId: je, entryNumber: je, entryDate: '2026-09-10', lineId: `l${++n}`,
  accountId: 'exp', accountCode: '6000', accountName: 'Expense', accountType: 'expense',
  accountSubtype: 'operating_expense', vatType: null, debit: 0, credit: 0, cancelledSource: false,
  ...over,
});
const vatIn = (je: string, debit: number, credit = 0, over: Partial<OverclaimLine> = {}) =>
  line(je, { accountId: 'vin', accountType: 'asset', accountSubtype: 'vat_input', vatType: 'standard', debit, credit, ...over });
const ap = (je: string, credit: number, debit = 0, over: Partial<OverclaimLine> = {}) =>
  line(je, { accountId: 'ap', accountType: 'liability', accountSubtype: 'payable', credit, debit, ...over });
const bill = (je: string, base: number, tax: number, over: Partial<OverclaimLine> = {}) =>
  [line(je, { debit: base, ...over }), vatIn(je, tax, 0, over), ap(je, base + tax, 0, over)];
const reversal = (je: string, of: string, base: number, tax: number) =>
  [line(je, { credit: base, reversalOfId: of }), vatIn(je, 0, tax, { reversalOfId: of }), ap(je, 0, base + tax, { reversalOfId: of })];

describe('perJournalInputOverclaim', () => {
  it('an under-claim and an over-claim in one period: the over-claim shows (the signed sum was 0)', () => {
    const lines = [...bill('under', 1000, 100), ...bill('over', 1000, 200)];
    expect(perJournalInputOverclaim(lines, [], RATE)).toBe(50);
  });

  it('ordinary bills tie: 0', () => {
    expect(perJournalInputOverclaim([...bill('a', 1000, 150), ...bill('b', 333.33, 50)], [], RATE)).toBe(0);
  });

  it('an under-claim alone is 0 — claiming less than the base allows is not an over-claim', () => {
    expect(perJournalInputOverclaim(bill('u', 1000, 10), [], RATE)).toBe(0);
  });

  it('a journal with input tax and no base: the whole tax is over-claimed', () => {
    const baseless = [vatIn('nb', 150), line('nb', { accountId: 'bank', accountType: 'asset', accountSubtype: 'bank', credit: 150 })];
    expect(perJournalInputOverclaim(baseless, [], RATE)).toBe(150);
  });

  it('a supplier credit note that reduces too little input VAT is an over-claim; one that reduces enough is not', () => {
    const cn = (je: string, base: number, tax: number) =>
      [line(je, { credit: base }), vatIn(je, 0, tax), ap(je, 0, base + tax)];
    expect(perJournalInputOverclaim(cn('short', 1000, 100), [], RATE)).toBe(50);
    expect(perJournalInputOverclaim(cn('full', 1000, 150), [], RATE)).toBe(0);
  });

  it('an over-claim reversed in the same period nets to 0 (the reversal is grouped with its original)', () => {
    const lines = [...bill('o', 1000, 200), ...reversal('r', 'o', 1000, 200)];
    expect(perJournalInputOverclaim(lines, [], RATE)).toBe(0);
  });

  it('a reversal alone (its original filed earlier) is not an over-claim', () => {
    expect(perJournalInputOverclaim(reversal('r', 'gone', 1000, 200), [], RATE)).toBe(0);
  });

  it('a late-claim companion is checked against the base it carries', () => {
    const clr = (je: string, credit: number) =>
      line(je, { accountId: 'clr', accountType: 'asset', accountSubtype: 'vat_input_late_claim', credit });
    const ok = [vatIn('c1', 150, 0, { lateClaimBase: 1000 }), clr('c1', 150)];
    const padded = [vatIn('c2', 180, 0, { lateClaimBase: 1000 }), clr('c2', 180)];
    const noBase = [vatIn('c3', 15, 0, { lateClaimBase: null }), clr('c3', 15)];
    expect(perJournalInputOverclaim([], ok, RATE)).toBe(0);
    expect(perJournalInputOverclaim([], padded, RATE)).toBe(30);
    expect(perJournalInputOverclaim([], noBase, RATE)).toBe(15);
  });

  it('output tax is not input tax: a sale is ignored', () => {
    const sale = [line('s', { accountType: 'revenue', accountSubtype: 'sales', credit: 1000 }),
      line('s', { accountId: 'vout', accountType: 'liability', accountSubtype: 'vat_output', vatType: 'standard', credit: 300 }),
      line('s', { accountId: 'ar', accountType: 'asset', accountSubtype: 'receivable', debit: 1300 })];
    expect(perJournalInputOverclaim(sale, [], RATE)).toBe(0);
  });

  it('a cancelled-source journal carries no tax leg and is ignored', () => {
    expect(perJournalInputOverclaim(bill('x', 100, 150, { cancelledSource: true }), [], RATE)).toBe(0);
  });
});
