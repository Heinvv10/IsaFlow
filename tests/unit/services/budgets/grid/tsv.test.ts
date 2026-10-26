/**
 * The TSV the grid writes on copy: raw `1234.50`, no separators, blank for an
 * unbudgeted cell. It must read back exactly through `parseClipboard`.
 */
import { describe, it, expect } from 'vitest';
import { toTsv, centsToPlain } from '@/modules/accounting/services/budgets/grid/tsv';
import { parseClipboard } from '@/modules/accounting/services/budgets/grid/pasteParse';

function readBack(text: string): (number | null)[][] {
  return parseClipboard(text).rows.map(r => r.map(c => {
    if (c.kind === 'error') throw new Error(`refused ${c.raw}: ${c.reason}`);
    return c.kind === 'blank' ? null : c.cents;
  }));
}

describe('centsToPlain', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [-5, '-0.05'],
    [123450, '1234.50'],
    [-123450, '-1234.50'],
    [999999999999999, '9999999999999.99'],
  ])('%s → %s', (cents, text) => {
    expect(centsToPlain(cents)).toBe(text);
  });
});

describe('toTsv', () => {
  it('writes raw numbers, tabs and a trailing newline', () => {
    expect(toTsv([[123450, null], [-5, 0]])).toBe('1234.50\t\n-0.05\t0.00\n');
  });

  it.each([
    [[[1]]],
    [[[123450, -99, null, 0]]],
    [[[null], [1]]],
    [[[1], [null]]],
    [[[null, null], [null, null]]],
    [[[-123456789, 0, 5], [null, 100, -1]]],
  ])('round-trips %j', m => {
    expect(readBack(toTsv(m))).toEqual(m);
  });

  it('a blank is empty, never 0', () => {
    expect(toTsv([[null]])).toBe('\n');
    expect(readBack(toTsv([[null, 0]]))).toEqual([[null, 0]]);
  });
});
