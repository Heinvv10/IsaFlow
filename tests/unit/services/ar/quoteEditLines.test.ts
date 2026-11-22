/**
 * A quote edit's sent lines matched to the stored ones (quoteEditLines): by id, then position (identical and of a
 * compatible rate), then the identical line anywhere, then position (edited in place); and whether a LEGACY quote's
 * edit left its lines as stored.
 */
import { describe, expect, it } from 'vitest';
import { keptQuoteTypes, legacyLinesUnchanged, matchQuoteLines, unmatchedVatProblem, type SentQuoteLine, type StoredQuoteVatLine } from '@/modules/accounting/services/ar/quoteEditLines';

const D = '2026-11-11';
const stored = (id: string, o: Partial<StoredQuoteVatLine>): StoredQuoteVatLine => ({
  id, description: 'Widget', quantity: 1, unitPrice: 100, taxRate: 15, amount: 100, taxAmount: 15, vatType: 'standard', ...o,
});
const std = stored('s1', {});
const ex = stored('s2', { vatType: 'exempt', taxRate: 0, taxAmount: 0 });
const ids = (m: ReturnType<typeof matchQuoteLines>) => m.matches.map((x) => x?.stored.id ?? null);

describe('matchQuoteLines', () => {
  it('twin lines, the first deleted: the remaining line resent at 0 matches the EXEMPT twin, not the standard one', () => {
    const m = matchQuoteLines([{ description: 'Widget', quantity: 1, unitPrice: 100, taxRate: 0 }], [std, ex], D);
    expect(ids(m)).toEqual(['s2']);
    expect(keptQuoteTypes(m.matches)).toEqual(['exempt']);
  });

  it('an id names its stored line whatever its position or content', () => {
    expect(ids(matchQuoteLines([{ id: 's2', description: 'Other', quantity: 3, unitPrice: 1 }], [std, ex], D))).toEqual(['s2']);
  });

  it('an exempt line whose price changed, resent at 0, matches itself by position and stays exempt', () => {
    const m = matchQuoteLines([{ description: 'Widget', quantity: 1, unitPrice: 120, taxRate: 0 }], [ex], D);
    expect(m.matches.map((x) => [x?.stored.id, x?.identical])).toEqual([['s2', false]]);
    expect(keptQuoteTypes(m.matches)).toEqual(['exempt']);
  });

  it('a rate the stored line does not carry is no position match (a standard line resent at 0)', () => {
    expect(ids(matchQuoteLines([{ description: 'Widget', quantity: 1, unitPrice: 120, taxRate: 0 }], [std], D))).toEqual([null]);
  });

  it('each stored line is matched once; an earlier pass is not robbed by a later one', () => {
    const m = matchQuoteLines([
      { description: 'Widget', quantity: 1, unitPrice: 100, taxRate: 0 },
      { id: 's2', description: 'Widget', quantity: 1, unitPrice: 100 },
    ], [std, ex], D);
    expect(ids(m)).toEqual([null, 's2']);
  });

  it('a legacy line\'s rate is its own (14% matches 14)', () => {
    const legacy = stored('l1', { vatType: null, taxAmount: null, taxRate: 14 });
    expect(ids(matchQuoteLines([{ description: 'Widget', quantity: 1, unitPrice: 100, taxRate: 14 }], [legacy], D))).toEqual(['l1']);
  });
});

describe('legacyLinesUnchanged', () => {
  const legacy = [stored('l1', { vatType: null, taxAmount: null, taxRate: 14 }), stored('l2', { description: 'B', vatType: null, taxAmount: null, taxRate: 14 })];
  const same = [{ description: 'Widget', quantity: 1, unitPrice: 100, taxRate: 14 }, { description: 'B', quantity: 1, unitPrice: 100 }];
  const check = (sent: typeof same, mode?: unknown, st = legacy) => legacyLinesUnchanged(sent, st, matchQuoteLines(sent, st, D).matches, mode);

  it('every line identical, no type, its own rate or none: unchanged', () => {
    expect(check(same)).toBe(true);
  });

  it('a changed price, a line deleted or added, a type named, another rate, or inclusive: changed', () => {
    expect(check([same[0]!, { ...same[1]!, unitPrice: 101 }])).toBe(false);
    expect(check([same[0]!])).toBe(false);
    expect(check([...same, { description: 'C', quantity: 1, unitPrice: 1 }])).toBe(false);
    expect(check([same[0]!, { ...same[1]!, vatType: 'standard' } as never])).toBe(false);
    expect(check([same[0]!, { ...same[1]!, taxRate: 15 }])).toBe(false);
    expect(check(same, 'inclusive')).toBe(false);
  });

  it('a typed quote is never "legacy unchanged"', () => {
    expect(check([{ description: 'Widget', quantity: 1, unitPrice: 100 }], undefined, [std])).toBe(false);
  });
});

describe('never guessed: a typeless line whose saved type cannot be told', () => {
  const hosting = stored('h', { description: 'Hosting' });
  const fee = stored('f', { description: 'Fee', unitPrice: 50, amount: 50, vatType: 'exempt', taxRate: 0, taxAmount: 0 });
  const problem = (sent: SentQuoteLine[], st: StoredQuoteVatLine[]) => unmatchedVatProblem(sent, st, matchQuoteLines(sent, st, D), D);

  it('Hosting (standard) deleted and Fee (exempt) re-priced: Fee matches itself by description, not Hosting by position', () => {
    const sent = [{ description: 'Fee', quantity: 1, unitPrice: 60 }];
    const m = matchQuoteLines(sent, [hosting, fee], D);
    expect(ids(m)).toEqual(['f']);
    expect(keptQuoteTypes(m.matches)).toEqual(['exempt']);
    expect(problem(sent, [hosting, fee])).toBeNull();
  });

  it('a line inserted above a re-priced exempt line: the exempt line keeps its type, the new one has no stored line', () => {
    const sent = [{ description: 'New', quantity: 1, unitPrice: 10 }, { description: 'Fee', quantity: 1, unitPrice: 60 }];
    expect(ids(matchQuoteLines(sent, [fee], D))).toEqual([null, 'f']);
    expect(problem(sent, [fee])).toBeNull();
  });

  it('a position is no match for another line (Hosting at 0 is not Fee renamed)', () => {
    expect(ids(matchQuoteLines([{ description: 'Fee (Nov)', quantity: 1, unitPrice: 60 }], [fee, hosting], D))).toEqual([null]);
  });

  it('a renamed and re-priced exempt line matches nothing and is REFUSED (asked for its vatType or id), not typed by the default chain', () => {
    expect(problem([{ description: 'Hosting', quantity: 1, unitPrice: 100 }, { description: 'Fee (Nov)', quantity: 1, unitPrice: 60 }], [hosting, fee]))
      .toBe('items[1] matches no saved line, and the quote had an exempt line it may be: send the line\'s vatType (standard, zero_rated or exempt) or the saved line\'s id.');
  });

  it('twins X standard + X exempt, the first deleted, sent with no id or rate: ambiguous, refused', () => {
    const sent = [{ description: 'Widget', quantity: 1, unitPrice: 100 }];
    const m = matchQuoteLines(sent, [std, ex], D);
    expect(ids(m)).toEqual([null]);
    expect([...m.ambiguous]).toEqual([0]);
    expect(problem(sent, [std, ex])).toMatch(/^items\[0\] could be more than one saved line of different VAT types/);
  });

  it('a named vatType, an id, or a rate that tells the twins apart is never refused', () => {
    expect(problem([{ description: 'Widget', quantity: 1, unitPrice: 100, vatType: 'exempt' }], [std, ex])).toBeNull();
    expect(problem([{ id: 's2', description: 'Widget', quantity: 1, unitPrice: 100 }], [std, ex])).toBeNull();
    expect(problem([{ description: 'Widget', quantity: 1, unitPrice: 100, taxRate: 0 }], [std, ex])).toBeNull();
  });

  it('a new typeless line beside only standard saved lines takes the default chain (no refusal)', () => {
    expect(problem([{ description: 'Hosting', quantity: 1, unitPrice: 100 }, { description: 'Extra', quantity: 1, unitPrice: 5 }], [hosting])).toBeNull();
  });
});
