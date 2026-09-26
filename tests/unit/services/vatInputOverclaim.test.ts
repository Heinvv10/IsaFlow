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
  // Every bill() journal here has exactly ONE taxed input-VAT line. Its
  // R0.005 allowance can never survive rounding to the cent (any single
  // whole-cent raw over-claim minus R0.005, re-rounded to 2dp, rounds straight
  // back to itself — see the "single-line R0.01 over-claim now shows" test
  // below) — R0.01 (the OLD flat allowance) is no longer subtracted from
  // these single-taxed-line figures.
  it('an under-claim and an over-claim in one period: the over-claim shows in full — no rounding allowance survives a single taxed line', () => {
    const lines = [...bill('under', 1000, 100), ...bill('over', 1000, 200)];
    expect(perJournalInputOverclaim(lines, [], RATE)).toBe(50);
  });

  it('ordinary bills tie: 0', () => {
    expect(perJournalInputOverclaim([...bill('a', 1000, 150), ...bill('b', 333.33, 50)], [], RATE)).toBe(0);
  });

  it('an under-claim alone is 0 — claiming less than the base allows is not an over-claim', () => {
    expect(perJournalInputOverclaim(bill('u', 1000, 10), [], RATE)).toBe(0);
  });

  it('a journal with input tax and no base: the whole tax is over-claimed in full — a single taxed line gets no allowance', () => {
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

  describe('rounding allowance — R0.005 per TAXED input-VAT line, per journal (Hein, 2026-09-26)', () => {
    it('150 SINGLE-line bills, each a one-cent per-line rounding tie, now show their full R0.01 each (single-line R0.01 over-claim now shows — it is not rounding)', () => {
      // 66.67 x 15% = 10.0005, coded on the invoice at 10.01: one cent of
      // apparent per-line rounding. A single taxed line's TRUE bound is only
      // R0.005, which cannot survive rounding to the cent — so this whole
      // cent, on each of the 150 journals, now shows: 150 x R0.01 = R1.50.
      // (Previously the OLD flat R0.01/line allowance hid every one of them.)
      const lines = Array.from({ length: 150 }, (_, i) => bill(`b${i}`, 66.67, 10.01)).flat();
      expect(perJournalInputOverclaim(lines, [], RATE)).toBe(1.5);
    });

    it('a single-line R0.01 over-claim now shows in full — it is not rounding', () => {
      // base 1000 @ 15% = 150.00; claimed 150.01 on the ONE taxed line. Under
      // the old flat R0.01/line allowance this tied to 0. A single line's
      // true rounding bound is half that (R0.005), which cannot be expressed
      // in cents, so the whole R0.01 now shows.
      expect(perJournalInputOverclaim(bill('one-cent-over', 1000, 150.01), [], RATE)).toBe(0.01);
    });

    it('a multi-line bill with 3 taxed lines whose per-line rounding sums within the R0.015 bound ties at 0', () => {
      // Three taxed input-VAT lines on ONE journal: allowance = 3 x R0.005 =
      // R0.015. A R0.01 raw discrepancy — exactly what three lines rounding
      // their own share of the tax to the nearest cent can genuinely produce
      // between them — sits inside that bound and ties.
      const je = 'three-line';
      const lines = [
        line(je, { debit: 1000 }),
        vatIn(je, 100.00), vatIn(je, 30.00), vatIn(je, 20.01), // 150.01 claimed vs 150.00 implied
        ap(je, 1150.01),
      ];
      expect(perJournalInputOverclaim(lines, [], RATE)).toBe(0);
    });

    it('a real over-claim well beyond the allowance is still flagged', () => {
      // base 1000 @ 15% = 150; claimed 500 — a genuine R350 over-claim, not
      // rounding. A single taxed line's R0.005 allowance cannot reduce it at
      // all once rounded back to the cent (see the single-line tests above).
      expect(perJournalInputOverclaim(bill('real', 1000, 500), [], RATE)).toBe(350);
    });

    it('200 untaxed (base-only) padding lines on the journal buy it no extra allowance', () => {
      const core = bill('padded', 1000, 155); // raw over-claim: 155 - 150 = 5
      const padding = Array.from({ length: 200 }, () => line('padded', { debit: 0, credit: 0 }));
      // Only the ONE taxed input-VAT line counts toward the allowance, and a
      // single line's allowance never survives cent rounding — same R5 as
      // the unpadded journal, never reduced by the 200 untaxed lines.
      expect(perJournalInputOverclaim([...core, ...padding], [], RATE)).toBe(5);
      expect(perJournalInputOverclaim(bill('unpadded', 1000, 155), [], RATE)).toBe(5);
    });

    it('splitting a genuine over-claim across many tiny TAXED lines buys no more than genuine rounding could', () => {
      // A real R1.00 over-claim (base 1000 @ 15% = 150; claimed 151) split
      // across 10 taxed input-VAT lines instead of one. Allowance scales with
      // the count (10 x R0.005 = R0.05), but that is nowhere near enough to
      // launder the R1.00 real over-claim — R0.95 of it still shows. Splitting
      // a claim across more tiny lines does not buy a bigger hiding place,
      // only the genuine half-a-cent-per-line rounding bound.
      const je = 'split-ten';
      const taxLines = Array.from({ length: 10 }, () => vatIn(je, 15.1));
      const lines = [line(je, { debit: 1000 }), ...taxLines, ap(je, 1151)];
      expect(perJournalInputOverclaim(lines, [], RATE)).toBe(0.95);
    });

    it('KNOWN LIMIT: correctly-taxed padding lines absorb at most R0.005 each of an unrelated over-claim — never more', () => {
      // A real R1.20 over-claim (base 1000 @ 15% = 150; claimed 151.20) plus N
      // exactly-correct padding bills-in-one (base 100, VAT 15). The allowance
      // is N+1 lines x R0.005. 250 padding lines: 251 x 0.005 = 1.255 >= 1.20,
      // hidden. 200 padding lines: 201 x 0.005 = 1.005, so R0.195 -> R0.20
      // (half-up, not the float 0.1949... -> 0.19) still shows. Pins that the
      // slack never exceeds half a cent per line.
      const je = (pad: number) => [
        line(`pad${pad}`, { debit: 1000 }), vatIn(`pad${pad}`, 151.2),
        ...Array.from({ length: pad }, () => [line(`pad${pad}`, { debit: 100 }), vatIn(`pad${pad}`, 15)]).flat(),
        ap(`pad${pad}`, 1151.2 + pad * 115),
      ];
      expect(perJournalInputOverclaim(je(0), [], RATE)).toBe(1.2);
      expect(perJournalInputOverclaim(je(200), [], RATE)).toBe(0.2);
      expect(perJournalInputOverclaim(je(250), [], RATE)).toBe(0);
    });
  });
});
