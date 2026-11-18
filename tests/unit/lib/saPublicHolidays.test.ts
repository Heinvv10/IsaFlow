/**
 * South African public holidays (Public Holidays Act 36 of 1994): the fixed days, Good Friday and Family Day
 * from Easter, and the s2(1) Sunday rule (a holiday on a Sunday makes the Monday a holiday).
 */
import { describe, expect, it } from 'vitest';
import { easterSunday, isSaPublicHoliday, saPublicHolidays } from '@/lib/saPublicHolidays';

describe('easterSunday (Gregorian)', () => {
  it.each([
    [2024, '2024-03-31'], [2025, '2025-04-20'], [2026, '2026-04-05'], [2027, '2027-03-28'], [2028, '2028-04-16'], [2038, '2038-04-25'],
  ])('%i -> %s', (year, iso) => {
    expect(easterSunday(year)).toBe(iso);
  });
});

describe('saPublicHolidays', () => {
  it('2026: the twelve statutory days, Good Friday 3 Apr and Family Day 6 Apr, 9 Aug (Sun) -> Mon 10 Aug', () => {
    expect(saPublicHolidays(2026)).toEqual([
      '2026-01-01', '2026-03-21', '2026-04-03', '2026-04-06', '2026-04-27', '2026-05-01', '2026-06-16',
      '2026-08-09', '2026-08-10', '2026-09-24', '2026-12-16', '2026-12-25', '2026-12-26',
    ]);
  });

  it('2027: Good Friday 26 Mar, Family Day 29 Mar; 21 Mar (Sun) -> Mon 22 Mar; 26 Dec (Sun) -> Mon 27 Dec', () => {
    const h = saPublicHolidays(2027);
    expect(h).toEqual(expect.arrayContaining(['2027-03-26', '2027-03-29', '2027-03-21', '2027-03-22', '2027-12-26', '2027-12-27']));
  });

  it('Sunday rule: 1 May 2022 (Sun) makes Mon 2 May a holiday; 16 Jun 2024 (Sun) makes Mon 17 Jun', () => {
    expect(isSaPublicHoliday('2022-05-01')).toBe(true);
    expect(isSaPublicHoliday('2022-05-02')).toBe(true);
    expect(isSaPublicHoliday('2024-06-16')).toBe(true);
    expect(isSaPublicHoliday('2024-06-17')).toBe(true);
  });

  it('a holiday on a Saturday does not move (21 Mar 2026 is a Saturday)', () => {
    expect(isSaPublicHoliday('2026-03-21')).toBe(true);
    expect(isSaPublicHoliday('2026-03-23')).toBe(false);
  });

  it('Sunday 25 Dec 2022 adds nothing new: Monday 26 Dec is already Day of Goodwill (no duplicate day)', () => {
    const h = saPublicHolidays(2022);
    expect(h.filter((d) => d === '2022-12-26')).toHaveLength(1);
    expect(isSaPublicHoliday('2022-12-27')).toBe(false);
  });

  it('ordinary days are not holidays', () => {
    expect(isSaPublicHoliday('2026-11-18')).toBe(false);
    expect(isSaPublicHoliday('2026-12-24')).toBe(false);
  });
});
