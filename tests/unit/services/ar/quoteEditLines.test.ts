/**
 * A quote edit's sent lines matched to the stored ones (quoteEditLines), review round 4's STRUCTURAL rule:
 *   - an `id` takes its stored line;
 *   - a quote holding ONLY standard lines matches by content in passes (nothing a wrong match could mistype);
 *   - a quote holding a zero-rated or exempt line (a legacy 0% line counts) lets a typeless line inherit a saved type
 *     ONLY from a positional resend (same count, each identical to its own place but at most one changed in place);
 *     any other shape refuses every line with neither id nor vatType (nor a legacy rate above 0).
 * And whether a LEGACY quote's edit left its lines as stored.
 */
import { describe, expect, it } from 'vitest';
import { keptQuoteTypes, legacyLinesUnchanged, matchQuoteLines, unmatchedVatProblem, type SentQuoteLine, type StoredQuoteVatLine } from '@/modules/accounting/services/ar/quoteEditLines';

const D = '2026-11-11';
const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const stored = (id: string, o: Partial<StoredQuoteVatLine>): StoredQuoteVatLine => ({
  id, description: 'Widget', quantity: 1, unitPrice: 100, taxRate: 15, amount: 100, taxAmount: 15, vatType: 'standard', ...o,
});
const EX = { vatType: 'exempt', taxRate: 0, taxAmount: 0 };
const ZR = { vatType: 'zero_rated', taxRate: 0, taxAmount: 0 };
const std = stored('s1', {});
const ex = stored('s2', EX);
const line = (o: Partial<SentQuoteLine>): SentQuoteLine => ({ description: 'Widget', quantity: 1, unitPrice: 100, ...o });
const run = (sent: SentQuoteLine[], st: StoredQuoteVatLine[]) => {
  const m = matchQuoteLines(sent, st, D);
  return { ids: m.matches.map((x) => x?.stored.id ?? null), kept: keptQuoteTypes(m.matches), refused: unmatchedVatProblem(sent, m) };
};
const REFUSED = /^items\[\d+\]: this quote has zero-rated or exempt lines, and the edit does not resend them in their places/;

describe('a quote with a zero-rated or exempt line: only a positional resend inherits', () => {
  it('twins standard + exempt resent unchanged in place (a notes-only save) keep their types', () => {
    expect(run([line({}), line({})], [std, ex])).toEqual({ ids: ['s1', 's2'], kept: ['standard', 'exempt'], refused: null });
  });

  it('one line re-priced in place, the others identical: it keeps its exempt type (description and case ignored for "identical")', () => {
    expect(run([line({ description: ' widget ' }), line({ unitPrice: 120 })], [std, ex])).toEqual({ ids: ['s1', 's2'], kept: ['standard', 'exempt'], refused: null });
  });

  it('H1: a sibling deleted (the count changed) and the twins shift: refused, not matched by place', () => {
    const other = stored('o', { description: 'Other', unitPrice: 1, amount: 1 });
    const r = run([line({}), line({})], [other, std, ex]);
    expect(r.ids).toEqual([null, null]);
    expect(r.refused).toMatch(REFUSED);
  });

  it('H2: the standard twin deleted, the remaining line resent at rate 0: refused (exempt or zero-rated cannot be told)', () => {
    expect(run([line({ taxRate: 0 })], [std, ex]).refused).toMatch(REFUSED);
  });

  it('H3: Hosting (standard) deleted, Fee (exempt) re-priced: refused, not typed by place or by the default chain', () => {
    const r = run([line({ description: 'Fee', unitPrice: 60 })], [stored('h', { description: 'Hosting' }), stored('f', { description: 'Fee', unitPrice: 50, ...EX })]);
    expect(r).toEqual({ ids: [null], kept: [null], refused: expect.stringMatching(REFUSED) });
  });

  it('M1: delete + add keeps the count but two lines differ from their places: refused', () => {
    const other = stored('o', { description: 'Other', unitPrice: 1, amount: 1 });
    expect(run([line({}), line({ description: 'Other', unitPrice: 1 }), line({ description: 'New', unitPrice: 5 })], [std, ex, other]).refused).toMatch(REFUSED);
  });

  it('a new line of the same item beside the zero-rated one (count changed): refused', () => {
    const exp = stored('zr', { description: 'Export service', itemId: A, ...ZR });
    expect(run([line({ description: 'Local service', unitPrice: 80, itemId: A }), line({ description: 'Export service', unitPrice: 120, itemId: A })], [exp]).refused).toMatch(REFUSED);
  });

  it('lines of different items are never identical: an item change is a change in place', () => {
    // Line 1's item changed A -> B: the one change in place; it keeps its place's type.
    expect(run([line({ itemId: B }), line({ itemId: B })], [stored('a', { itemId: A }), stored('b', { itemId: B, ...EX })]))
      .toEqual({ ids: ['a', 'b'], kept: ['standard', 'exempt'], refused: null });
    expect(run([line({ itemId: B }), line({ itemId: A })], [stored('a', { itemId: A }), stored('b', { itemId: B, ...EX })]).refused).toMatch(REFUSED);
  });

  it('a legacy 0% line (no type) counts: renaming it with a line added is refused', () => {
    const legacy0 = stored('l', { description: 'Fee', vatType: null, taxAmount: null, taxRate: 0 });
    expect(run([line({ description: 'Fee (Nov)' }), line({ description: 'Extra' })], [legacy0]).refused).toMatch(REFUSED);
  });

  it('never refused: a line with an id (L3), a named vatType, or a legacy rate above 0 (standard by itself)', () => {
    const fee = stored('f', { description: 'Fee', unitPrice: 50, ...EX });
    expect(run([line({ id: 'f', description: 'Fee', unitPrice: 50 }), line({ description: 'Fee', unitPrice: 50, vatType: 'standard' })], [fee]))
      .toEqual({ ids: ['f', null], kept: ['exempt', null], refused: null });
    expect(run([line({ description: 'New', taxRate: 15 }), line({ id: 'f', description: 'Fee', unitPrice: 50 })], [fee]).refused).toBeNull();
  });

  it('an id that names another place breaks the positional resend: the typeless lines are refused', () => {
    expect(run([line({ id: 's2' }), line({})], [std, ex]).refused).toMatch(/^items\[1\]/);
  });
});

describe('a quote of standard lines only: content passes, no refusal (nothing to mistype)', () => {
  const hosting = stored('h', { description: 'Hosting' });
  it('matches identical, then same description, then same item, anywhere; a new line has no match', () => {
    const r = run([line({ description: 'New', unitPrice: 5 }), line({ description: 'hosting', unitPrice: 120 }), line({ unitPrice: 1, description: 'W2', itemId: A })],
      [hosting, stored('w', { itemId: A })]);
    expect(r).toEqual({ ids: [null, 'h', 'w'], kept: [null, 'standard', 'standard'], refused: null });
  });
});

describe('legacyLinesUnchanged', () => {
  const legacy = [stored('l1', { vatType: null, taxAmount: null, taxRate: 14 }), stored('l2', { description: 'B', vatType: null, taxAmount: null, taxRate: 14 })];
  const same = [{ description: 'Widget', quantity: 1, unitPrice: 100, taxRate: 14 }, { description: 'B', quantity: 1, unitPrice: 100 }];
  const check = (sent: SentQuoteLine[], mode?: unknown, st = legacy) => legacyLinesUnchanged(sent, st, matchQuoteLines(sent, st, D).matches, mode);

  it('every line identical, no type, its own rate or none: unchanged', () => {
    expect(check(same)).toBe(true);
  });

  it('a legacy 0% quote resent in place is unchanged too (the positional resend)', () => {
    const zero = [stored('z', { vatType: null, taxAmount: null, taxRate: 0 })];
    expect(check([{ description: 'Widget', quantity: 1, unitPrice: 100 }], undefined, zero)).toBe(true);
  });

  it('a changed price, a line deleted or added, a type named, another rate, or inclusive: changed', () => {
    expect(check([same[0]!, { ...same[1]!, unitPrice: 101 }])).toBe(false);
    expect(check([same[0]!])).toBe(false);
    expect(check([...same, { description: 'C', quantity: 1, unitPrice: 1 }])).toBe(false);
    expect(check([same[0]!, { ...same[1]!, vatType: 'standard' }])).toBe(false);
    expect(check([same[0]!, { ...same[1]!, taxRate: 15 }])).toBe(false);
    expect(check(same, 'inclusive')).toBe(false);
  });

  it('a typed quote is never "legacy unchanged"', () => {
    expect(check([{ description: 'Widget', quantity: 1, unitPrice: 100 }], undefined, [std])).toBe(false);
  });
});
