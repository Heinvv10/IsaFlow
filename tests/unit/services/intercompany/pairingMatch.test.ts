/** Intercompany P3: suggesting pairs by document number + amount, and sorting what is left into exceptions. Pure. */
import { describe, expect, it } from 'vitest';
import { matchDocuments, normaliseNumber } from '@/modules/accounting/services/intercompany/pairingMatch';
import type { PairingDoc } from '@/modules/accounting/services/intercompany/pairingTypes';

let n = 0;
const doc = (number: string, total: number, over: Partial<PairingDoc> = {}): PairingDoc => ({
  id: `d-${++n}`, number, date: '2026-08-15', total, open: total, currency: 'ZAR', ...over,
});

describe('normaliseNumber', () => {
  it.each([
    ['INV-0042', 'INV42'], ['inv 42', 'INV42'], ['INV/42', 'INV42'], ['00042', '42'], ['A-007-B', 'A7B'], ['INV-100', 'INV100'], ['', ''],
  ])('%s -> %s', (input, expected) => expect(normaliseNumber(input)).toBe(expected));

  it('keeps a number that only contains zeros distinct from empty, and does not merge 10 with 1', () => {
    expect(normaliseNumber('0')).toBe('0');
    expect(normaliseNumber('INV-10')).not.toBe(normaliseNumber('INV-1'));
  });
});

describe('matchDocuments', () => {
  it('suggests a pair when the number (ignoring case, punctuation and leading zeros) and the total agree', () => {
    const mine = doc('INV-0042', 1150);
    const theirs = doc('inv42', 1150);
    const r = matchDocuments([mine], [theirs]);
    expect(r.suggestions).toEqual([{ mine, theirs, ambiguous: false, openDiffers: false }]);
    expect(r.mismatches).toEqual([]);
    expect(r.unmatchedMine).toEqual([]);
    expect(r.unmatchedTheirs).toEqual([]);
  });

  it('flags when the open amounts differ although the totals agree (one side has been part-paid)', () => {
    const r = matchDocuments([doc('1', 1000, { open: 400 })], [doc('1', 1000, { open: 1000 })]);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({ openDiffers: true });
  });

  it('reports the same number with a different total as an amount mismatch, not a suggestion', () => {
    const mine = doc('INV-1', 1000);
    const theirs = doc('INV-1', 1100);
    const r = matchDocuments([mine], [theirs]);
    expect(r.suggestions).toEqual([]);
    expect(r.mismatches).toEqual([{ mine, theirs, ambiguous: false, openDiffers: true }]);
  });

  it('leaves a document with no counterpart on its own side of the exceptions', () => {
    const a = doc('A-1', 100);
    const b = doc('B-1', 100);
    const r = matchDocuments([a], [b]);
    expect(r.unmatchedMine).toEqual([a]);
    expect(r.unmatchedTheirs).toEqual([b]);
    expect(r.suggestions).toEqual([]);
  });

  it('never matches on the amount alone', () => {
    const r = matchDocuments([doc('X-1', 500)], [doc('Y-9', 500)]);
    expect(r.suggestions).toEqual([]);
    expect(r.mismatches).toEqual([]);
  });

  it('pairs equal totals first when one number appears twice, and marks every pair of a repeated number ambiguous', () => {
    const m1 = doc('7', 100);
    const m2 = doc('7', 200);
    const t1 = doc('7', 200);
    const t2 = doc('7', 100);
    const r = matchDocuments([m1, m2], [t1, t2]);
    expect(r.suggestions.map((s) => [s.mine.id, s.theirs.id, s.ambiguous])).toEqual([[m1.id, t2.id, true], [m2.id, t1.id, true]]);
    expect(r.mismatches).toEqual([]);
  });

  it('pairs the leftovers of a repeated number as a mismatch and leaves the odd one out unmatched', () => {
    const m1 = doc('7', 100);
    const m2 = doc('7', 300);
    const t1 = doc('7', 100);
    const r = matchDocuments([m1, m2], [t1]);
    expect(r.suggestions.map((s) => s.mine.id)).toEqual([m1.id]);
    expect(r.unmatchedMine).toEqual([m2]);
  });

  it('never suggests a foreign-currency document: it goes to unsupported, on whichever side', () => {
    const usd = doc('F-1', 100, { currency: 'USD' });
    const zar = doc('F-1', 100);
    const r = matchDocuments([usd], [zar]);
    expect(r.suggestions).toEqual([]);
    expect(r.unsupported).toEqual([usd]);
    expect(r.unmatchedTheirs).toEqual([zar]);
    expect(matchDocuments([zar], [usd]).unsupported).toEqual([usd]);
  });

  it('compares totals to the cent, not as floating point', () => {
    const r = matchDocuments([doc('1', 0.1 + 0.2)], [doc('1', 0.3)]);
    expect(r.suggestions).toHaveLength(1);
  });

  it('does not match a number that normalises to nothing', () => {
    const r = matchDocuments([doc('---', 100)], [doc('///', 100)]);
    expect(r.suggestions).toEqual([]);
    expect(r.unmatchedMine).toHaveLength(1);
  });
});
