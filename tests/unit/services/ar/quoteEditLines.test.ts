/**
 * A quote edit's sent lines matched to the stored ones (quoteEditLines), review round 4's STRUCTURAL rule:
 *   - an `id` takes its stored line;
 *   - a quote holding ONLY standard lines matches at its own place or by a description that tells its item and account
 *     apart (round 12; the refusals are in quoteServiceVatRefs.test);
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

describe('review round 5: the positional resend checks the rate, the one change keeps its description or item', () => {
  const legacy = (id: string, description: string, rate: number) => stored(id, { description, vatType: null, taxAmount: null, taxRate: rate });

  it('H1: a legacy quote resent identical but at another legacy rate is not a positional resend (nor "unchanged")', () => {
    const st = [legacy('a', 'A', 15), legacy('b', 'B', 0)];
    const sent = [line({ description: 'A', taxRate: 15 }), line({ description: 'B', taxRate: 15 })];
    const m = matchQuoteLines(sent, st, D);
    expect(m.positional).toBe(false);
    expect(legacyLinesUnchanged(sent, st, m.matches, undefined)).toBe(false);
    expect(unmatchedVatProblem(sent, m)).toBeNull(); // rate 15 types each line standard by itself
    const single = [legacy('z', 'Rent', 0)];
    const rent = [line({ description: 'Rent', unitPrice: 100, taxRate: 15 })];
    expect(legacyLinesUnchanged(rent, single, matchQuoteLines(rent, single, D).matches, undefined)).toBe(false);
  });

  it('M1: the one line changed both its description and its item: another line, refused', () => {
    const bread = stored('x', { description: 'Bread', unitPrice: 10, itemId: A, ...ZR });
    expect(run([line({ description: 'Labour', quantity: 3, unitPrice: 500, itemId: B })], [bread]).refused).toMatch(REFUSED);
    expect(run([line({ description: 'Labour', quantity: 3, unitPrice: 500 })], [bread]).refused).toMatch(REFUSED);
    // Keeping either is the same line edited: it keeps zero-rated.
    expect(run([line({ description: 'Bread', unitPrice: 12, itemId: B })], [bread]).kept).toEqual(['zero_rated']);
    expect(run([line({ description: 'Rye bread', unitPrice: 12, itemId: A })], [bread]).kept).toEqual(['zero_rated']);
  });

  it('M1: [A standard, B zero-rated], B deleted and a typeless Consulting appended (same count): refused', () => {
    expect(run([line({ description: 'A' }), line({ description: 'Consulting', quantity: 2, unitPrice: 900 })],
      [stored('a', { description: 'A' }), stored('b', { description: 'B', ...ZR })]).refused).toMatch(REFUSED);
  });

  it('L1: a missing or non-text description reads as empty, never a crash', () => {
    expect(() => matchQuoteLines([{ quantity: 1, unitPrice: 1 } as unknown as SentQuoteLine, line({ description: 7 as unknown as string })], [std, ex], D)).not.toThrow();
  });

  it('L2 / L3: ids compare case-insensitively, and a line sent by id is not "the one change"', () => {
    const st = [stored('aa-1', { description: 'A' }), stored('bb-2', { description: 'B', ...EX }), stored('cc-3', { description: 'C' })];
    const r = run([line({ id: 'AA-1', description: 'A renamed', unitPrice: 1 }), line({ description: 'B', unitPrice: 150 }), line({ description: 'C' })], st);
    expect(r).toEqual({ ids: ['aa-1', 'bb-2', 'cc-3'], kept: ['standard', 'exempt', 'standard'], refused: null });
  });
});

describe('review round 6: a line matched by id is never "unchanged" at another rate', () => {
  const legacy = (id: string, description: string, rate: number) => stored(id, { description, vatType: null, taxAmount: null, taxRate: rate });
  const unchanged = (sent: SentQuoteLine[], st: StoredQuoteVatLine[]) => legacyLinesUnchanged(sent, st, matchQuoteLines(sent, st, D).matches, undefined);

  it('legacy 15% line sent by id at rate 0, a 0% line by id (any case) at 15, a standard-only line by id at 14: none unchanged', () => {
    expect(unchanged([line({ id: 'a', description: 'Svc', taxRate: 0 })], [legacy('a', 'Svc', 15)])).toBe(false);
    expect(unchanged([line({ id: 'A', description: 'Svc', taxRate: 15 })], [legacy('a', 'Svc', 0)])).toBe(false);
    expect(unchanged([line({ id: 'a', description: 'Svc', taxRate: 14 })], [legacy('a', 'Svc', 15)])).toBe(false);
  });

  it('legacy [Export 0%, Local 15%] both by id at rate 15: not unchanged, and each keeps its identity', () => {
    const st = [legacy('e', 'Export', 0), legacy('l', 'Local', 15)];
    const sent = [line({ id: 'e', description: 'Export', taxRate: 15 }), line({ id: 'l', description: 'Local', taxRate: 15 })];
    const m = matchQuoteLines(sent, st, D);
    expect(m.matches.map((x) => [x?.stored.id, x?.identical])).toEqual([['e', false], ['l', true]]);
    expect(legacyLinesUnchanged(sent, st, m.matches, undefined)).toBe(false);
  });

  it('the same lines by id at their own rates are unchanged', () => {
    expect(unchanged([line({ id: 'e', description: 'Export', taxRate: 0 }), line({ id: 'l', description: 'Local', taxRate: 15 })],
      [legacy('e', 'Export', 0), legacy('l', 'Local', 15)])).toBe(true);
  });
});

describe('round 6 LOW 1: an item added, changed or removed is a change, never "unchanged"', () => {
  const legacy = (o: Partial<StoredQuoteVatLine>) => stored('a', { description: 'Svc', vatType: null, taxAmount: null, taxRate: 15, ...o });
  const unchanged = (sent: SentQuoteLine[], st: StoredQuoteVatLine[]) => legacyLinesUnchanged(sent, st, matchQuoteLines(sent, st, D).matches, undefined);

  it('a legacy line with no item resent identical but naming an item: changed', () => {
    expect(unchanged([line({ description: 'Svc', itemId: A })], [legacy({})])).toBe(false);
  });
  it('the stored item removed (null or \'\') or changed: changed; left out (kept by itemEditLines) or the same: unchanged', () => {
    expect(unchanged([line({ description: 'Svc', itemId: null as unknown as string })], [legacy({ itemId: A })])).toBe(false);
    expect(unchanged([line({ description: 'Svc', itemId: '' })], [legacy({ itemId: A })])).toBe(false);
    expect(unchanged([line({ description: 'Svc', itemId: B })], [legacy({ itemId: A })])).toBe(false);
    expect(unchanged([line({ description: 'Svc' })], [legacy({ itemId: A })])).toBe(true);
    expect(unchanged([line({ description: 'Svc', itemId: A.toUpperCase() })], [legacy({ itemId: A })])).toBe(true);
  });
});

describe('round 7: an item added on a typed quote\'s positional resend is no change; changed or removed still is', () => {
  const plain = [stored('s', { description: 'Hosting' }), stored('e', { description: 'Rent', ...EX })];
  it('items added to both lines (none stored): still a positional resend, types kept', () => {
    expect(run([line({ description: 'Hosting', itemId: A }), line({ description: 'Rent', itemId: B })], plain))
      .toEqual({ ids: ['s', 'e'], kept: ['standard', 'exempt'], refused: null });
  });
  it('both stored items changed, or both removed: two changes, refused', () => {
    const withItems = [stored('s', { description: 'Hosting', itemId: A }), stored('e', { description: 'Rent', itemId: A, ...EX })];
    expect(run([line({ description: 'Hosting', itemId: B }), line({ description: 'Rent', itemId: B })], withItems).refused).toMatch(REFUSED);
    expect(run([line({ description: 'Hosting', itemId: null as unknown as string }), line({ description: 'Rent', itemId: '' })], withItems).refused).toMatch(REFUSED);
  });
  it('on the legacy "unchanged" decision an added item IS a change, and a stored upper-case item id sent lower-case is not', () => {
    const legacy = (o: Partial<StoredQuoteVatLine>) => stored('a', { description: 'Svc', vatType: null, taxAmount: null, taxRate: 15, ...o });
    const unchanged = (sent: SentQuoteLine[], st: StoredQuoteVatLine[]) => legacyLinesUnchanged(sent, st, matchQuoteLines(sent, st, D).matches, undefined);
    expect(unchanged([line({ description: 'Svc', itemId: A })], [legacy({})])).toBe(false);
    expect(unchanged([line({ description: 'Svc', itemId: A })], [legacy({ itemId: A.toUpperCase() })])).toBe(true);
  });
});

describe('a quote of standard lines only: content passes, no refusal (nothing to mistype)', () => {
  const hosting = stored('h', { description: 'Hosting' });
  it('a unique description pairs anywhere; a line of a new description (renamed elsewhere) is a new line', () => {
    const r = run([line({ description: 'New', unitPrice: 5 }), line({ description: 'hosting', unitPrice: 120 }), line({ unitPrice: 1, description: 'W2', itemId: A })],
      [hosting, stored('w', { itemId: A })]);
    expect(r).toEqual({ ids: [null, 'h', null], kept: [null, 'standard', null], refused: null });
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

describe('a standard-only quote: a match needs a compatible rate and a free stored line', () => {
  const other = stored('o', { description: 'Other', unitPrice: 1, amount: 1 });
  const w = stored('w', { itemId: A });

  it('a line resent at a legacy rate its stored line does not have matches nothing, at its place or by content', () => {
    expect(run([line({ taxRate: 0 })], [w]).ids).toEqual([null]);
    expect(run([line({ taxRate: 0 })], [other, w]).ids).toEqual([null]);
    expect(run([line({ taxRate: 15 })], [other, w]).ids).toEqual(['w']);
  });

  it('two sent lines of a unique stored description: the one at its place pairs, the other is a new line', () => {
    expect(run([line({}), line({ unitPrice: 120 })], [other, w]).ids).toEqual([null, 'w']);
    expect(run([line({}), line({ unitPrice: 120 })], [w, other]).ids).toEqual(['w', null]);
  });
});
