/**
 * THE OVERDUE COUNT IS MEASURED TO THE DATE THE PACK IS ABOUT.
 *
 * The board pack printed "Annual Financial Statements for FY2024 is 739 days
 * overdue" four times per pack while its cover, its footer, its period line,
 * its preparation line and its extraction timestamp all said 7 September
 * 2026. 739 is the count to the SIXTH. Two errors in one expression: the
 * anchor was `Date.now()` — the wall clock, not the reporting date — and a
 * `Math.floor` over a millisecond difference measures elapsed time rather
 * than calendar days, so the printed number moved with the hour the render
 * happened to run at.
 *
 * A director with a calendar gets a different number from the pack, and there
 * is nothing on the sheet stating a counting convention that would reconcile
 * them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlSpy } = vi.hoisted(() => ({ sqlSpy: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlSpy }));

import { getOverdueStatutoryFilings } from '@/modules/accounting/services/reports/statutoryFilingsService';

/** One unsigned AFS for a March-start company: FY2024 ends 29 February 2024,
 *  and the deadline is six months later — 29 August 2024. */
function afsFor(fiscalYear: number): void {
  sqlSpy.mockResolvedValue([{ fiscal_year: fiscalYear, financial_year_start: 3 }]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOverdueStatutoryFilings', () => {
  it('counts whole calendar days to the reporting date, not to the clock', async () => {
    afsFor(2026);
    const [filing] = await getOverdueStatutoryFilings('c1', '2026-09-07');
    // FY2026 ends 28 February 2026 for a March-start company, so the deadline
    // is 28 August 2026. 28 August to 7 September is TEN days; the old
    // expression, anchored on `Date.now()`, returned nine or ten according to
    // the hour, and on the live pack it printed 739 where the reporting date
    // gives 740.
    const due = Date.UTC(2026, 7, 28);
    const expected = Math.round((Date.UTC(2026, 8, 7) - due) / 86_400_000);
    expect(filing!.deadline).toBe('2026-08-28');
    expect(filing!.daysOverdue).toBe(expected);
    expect(filing!.daysOverdue).toBe(10);
  });

  it('gives the same answer whatever hour of the reporting date it runs at', async () => {
    // The defect that made this move: a millisecond floor against `Date.now()`.
    // Freezing the clock at either end of the day must change nothing.
    afsFor(2024);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-07T00:05:00.000Z'));
      const [early] = await getOverdueStatutoryFilings('c1', '2026-09-07');
      vi.setSystemTime(new Date('2026-09-07T23:55:00.000Z'));
      const [late] = await getOverdueStatutoryFilings('c1', '2026-09-07');
      expect(early!.daysOverdue).toBe(late!.daysOverdue);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports nothing for a deadline that has not passed at the reporting date', async () => {
    // The boundary in the direction that matters: a pack run BEFORE a
    // deadline must not list the filing as overdue because the render machine
    // is a day ahead of the period.
    afsFor(2026);
    expect(await getOverdueStatutoryFilings('c1', '2026-08-28')).toEqual([]);
    const [oneDay] = await getOverdueStatutoryFilings('c1', '2026-08-29');
    expect(oneDay!.daysOverdue).toBe(1);
  });
});
