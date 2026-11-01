/**
 * The date helpers of the hosted Golden Paths seed (scripts/ci/golden-hosted/seed-demo-app.ts): the seed must land
 * in the recent past, in complete months, spread over all of them.
 */
import { describe, it, expect } from 'vitest';
import { seedDate, seedMonths } from '../../../scripts/ci/golden-hosted/seed-demo-app';

describe('seedMonths', () => {
  it('is the 10 complete months before the run, oldest first', () => {
    expect(seedMonths(new Date('2026-11-01T08:00:00Z'))).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
    ]);
  });

  it('crosses a year end', () => {
    const months = seedMonths(new Date('2027-02-15T08:00:00Z'));
    expect(months[0]).toBe('2026-04');
    expect(months[9]).toBe('2027-01');
    expect(new Set(months).size).toBe(10);
  });

  it('never includes the month of the run (a period still open and in flux)', () => {
    expect(seedMonths(new Date('2026-12-31T23:00:00Z'))).not.toContain('2026-12');
  });
});

describe('seedDate', () => {
  const months = seedMonths(new Date('2026-11-01T08:00:00Z'));

  it('puts every item on day 3..20 of one of the months, so no date is invalid or in the future', () => {
    for (let i = 1; i <= 200; i++) {
      const d = seedDate(months, i);
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(months).toContain(d.slice(0, 7));
      const day = Number(d.slice(8));
      expect(day).toBeGreaterThanOrEqual(3);
      expect(day).toBeLessThanOrEqual(20);
    }
  });

  it('spreads items over all the months', () => {
    expect(new Set(Array.from({ length: 80 }, (_, k) => seedDate(months, k + 1).slice(0, 7))).size).toBe(10);
  });
});
