/**
 * parseImportDate turns the date formats a South African source file carries
 * into ISO YYYY-MM-DD. Day first, always: 03/04/2026 is 3 April, never 4 March.
 */
import { describe, it, expect } from 'vitest';
import { parseImportDate } from '@/lib/parseImportDate';

describe('parseImportDate', () => {
  it.each([
    ['2026-04-03', '2026-04-03'],
    ['2026-04-03 00:00:00', '2026-04-03'],
    ['2026-04-03T10:15:00Z', '2026-04-03'],
    ['03/04/2026', '2026-04-03'],
    ['03-04-2026', '2026-04-03'],
    ['03.04.2026', '2026-04-03'],
    ['3/4/2026', '2026-04-03'],
    ['31/12/2026', '2026-12-31'],
    ['2026/04/03', '2026-04-03'],
    ['03 Apr 2026', '2026-04-03'],
    ['3 April 2026', '2026-04-03'],
    ['03-Apr-2026', '2026-04-03'],
    ['03 SEPT 2026', '2026-09-03'],
    ['  03/04/2026  ', '2026-04-03'],
  ])('reads %j as %s', (input, expected) => {
    expect(parseImportDate(input)).toBe(expected);
  });

  it('is day-first: never reads a US month-first date', () => {
    expect(parseImportDate('04/03/2026')).toBe('2026-03-04');
    // 13 cannot be a month, and the parser does not swap to make it fit.
    expect(parseImportDate('12/13/2026')).toBeNull();
  });

  it('reads Excel serial numbers', () => {
    expect(parseImportDate(46115)).toBe('2026-04-03');
    expect(parseImportDate('46115')).toBe('2026-04-03');
    expect(parseImportDate(45658)).toBe('2025-01-01');
  });

  it.each(['', '   ', 'not a date', '31/02/2026', '2026-02-30', '29/02/2027', '00/01/2026', '2026-13-01', '03 Foo 2026'])(
    'returns null for %j',
    input => {
      expect(parseImportDate(input)).toBeNull();
    },
  );

  it('accepts a real leap day', () => {
    expect(parseImportDate('29/02/2028')).toBe('2028-02-29');
  });

  it('returns null for null and undefined', () => {
    expect(parseImportDate(null)).toBeNull();
    expect(parseImportDate(undefined)).toBeNull();
  });
});
