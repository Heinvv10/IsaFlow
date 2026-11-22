/**
 * A quote edit's sent lines matched to the stored ones (quoteEditLines): by id, then position (identical and of a
 * compatible rate), then the identical line anywhere, then position (edited in place); and whether a LEGACY quote's
 * edit left its lines as stored.
 */
import { describe, expect, it } from 'vitest';
import { keptQuoteTypes, legacyLinesUnchanged, matchQuoteLines, type StoredQuoteVatLine } from '@/modules/accounting/services/ar/quoteEditLines';

const D = '2026-11-11';
const stored = (id: string, o: Partial<StoredQuoteVatLine>): StoredQuoteVatLine => ({
  id, description: 'Widget', quantity: 1, unitPrice: 100, taxRate: 15, amount: 100, taxAmount: 15, vatType: 'standard', ...o,
});
const std = stored('s1', {});
const ex = stored('s2', { vatType: 'exempt', taxRate: 0, taxAmount: 0 });
const ids = (m: ReturnType<typeof matchQuoteLines>) => m.map((x) => x?.stored.id ?? null);

describe('matchQuoteLines', () => {
  it('twin lines, the first deleted: the remaining line resent at 0 matches the EXEMPT twin, not the standard one', () => {
    const m = matchQuoteLines([{ description: 'Widget', quantity: 1, unitPrice: 100, taxRate: 0 }], [std, ex], D);
    expect(ids(m)).toEqual(['s2']);
    expect(keptQuoteTypes(m)).toEqual(['exempt']);
  });

  it('an id names its stored line whatever its position or content', () => {
    expect(ids(matchQuoteLines([{ id: 's2', description: 'Other', quantity: 3, unitPrice: 1 }], [std, ex], D))).toEqual(['s2']);
  });

  it('an exempt line whose price changed, resent at 0, matches itself by position and stays exempt', () => {
    const m = matchQuoteLines([{ description: 'Widget', quantity: 1, unitPrice: 120, taxRate: 0 }], [ex], D);
    expect(m.map((x) => [x?.stored.id, x?.identical])).toEqual([['s2', false]]);
    expect(keptQuoteTypes(m)).toEqual(['exempt']);
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
  const check = (sent: typeof same, mode?: unknown, st = legacy) => legacyLinesUnchanged(sent, st, matchQuoteLines(sent, st, D), mode);

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
