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
 *
 * AND THE DEADLINE ITSELF WAS A DAY TO THREE OUT. Year end plus six months was
 * `setMonth(getMonth() + 6)` on the last day of a month, which overflows into
 * the next one wherever the sixth month is shorter (31 March gave 1 October)
 * and stops short wherever it is longer (28 February gave 28 August). A year
 * end is a month end, so six months after it is the END of the sixth month.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlSpy, getFiscalYearMock } = vi.hoisted(() => ({ sqlSpy: vi.fn(), getFiscalYearMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlSpy }));
// The year end is the registry year's (a stored fiscal_years row), not a start month re-applied.
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', () => ({ getFiscalYear: getFiscalYearMock }));

import {
  FilingDeadlineUnknownError,
  getOverdueStatutoryFilings,
} from '@/modules/accounting/services/reports/statutoryFilingsService';

/** A March-start company's registry year ends on the last day of February of its label. */
const februaryEnd = (label: number): string => `${label}-02-${label % 4 === 0 ? 29 : 28}`;

/** One unsigned AFS whose registry year ends on `yearEnd` (the label's last day of February by default; null: no such year). */
function afsFor(fiscalYear: number, yearEnd?: string | null): void {
  sqlSpy.mockResolvedValue([{ fiscal_year: fiscalYear }]);
  getFiscalYearMock.mockImplementation(async (_companyId: string, label: number) =>
    yearEnd === null
      ? null
      : { fiscalYear: label, startDate: '2000-01-01', endDate: yearEnd ?? februaryEnd(label) });
}

/** The one query the service ran, as the template it was written as: the
 *  literal SQL between the interpolations, and the interpolated values. */
function theQuery(): { strings: readonly string[]; values: unknown[]; text: string } {
  expect(sqlSpy).toHaveBeenCalledTimes(1);
  const [strings, ...values] = sqlSpy.mock.calls[0] as [readonly string[], ...unknown[]];
  return { strings, values, text: strings.join('$') };
}

/** The value interpolated immediately after the SQL fragment matching `before`. */
function boundAfter(before: RegExp): unknown {
  const { strings, values } = theQuery();
  const at = strings.findIndex((s) => before.test(s));
  expect(at, `no SQL fragment ends with ${String(before)}`).toBeGreaterThanOrEqual(0);
  return values[at];
}

/** Far enough out that every deadline under test has passed. */
const LONG_AFTER = '2030-01-01';

async function deadlineOf(fiscalYear: number, yearEnd: string): Promise<string> {
  afsFor(fiscalYear, yearEnd);
  const [filing] = await getOverdueStatutoryFilings('c1', LONG_AFTER);
  return filing!.deadline;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOverdueStatutoryFilings', () => {
  it('counts whole calendar days to the reporting date, not to the clock', async () => {
    afsFor(2026);
    const [filing] = await getOverdueStatutoryFilings('c1', '2026-09-07');
    // FY2026 ends 28 February 2026 for a March-start company, so the deadline
    // is the end of the sixth month after it: 31 August 2026. 31 August to
    // 7 September is SEVEN days.
    expect(filing!.deadline).toBe('2026-08-31');
    expect(filing!.daysOverdue).toBe(7);
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
    // The boundary in the direction that matters: a pack run ON the deadline
    // must not list the filing as overdue.
    afsFor(2026);
    expect(await getOverdueStatutoryFilings('c1', '2026-08-31')).toEqual([]);
    const [oneDay] = await getOverdueStatutoryFilings('c1', '2026-09-01');
    expect(oneDay!.daysOverdue).toBe(1);
  });

  describe('the deadline is the end of the sixth month after the year end', () => {
    it('28 February gives 31 August, not 28 August', async () => {
      expect(await deadlineOf(2026, '2026-02-28')).toBe('2026-08-31');
    });

    it('29 February in a leap year gives 31 August', async () => {
      expect(await deadlineOf(2024, '2024-02-29')).toBe('2024-08-31');
    });

    it('31 March gives 30 September, not 1 October', async () => {
      expect(await deadlineOf(2026, '2026-03-31')).toBe('2026-09-30');
    });

    it('31 August gives the last day of February, in a common year and a leap year', async () => {
      // 31 August 2025 + 6 months overflowed to 3 March 2026.
      expect(await deadlineOf(2025, '2025-08-31')).toBe('2026-02-28');
      expect(await deadlineOf(2027, '2027-08-31')).toBe('2028-02-29');
    });

    it('31 December gives 30 June of the next year, not 1 July', async () => {
      // A January-start company: fiscal year N is calendar year N.
      expect(await deadlineOf(2025, '2025-12-31')).toBe('2026-06-30');
    });

    it('a 14-month transition year falls due six months after ITS end, not after a twelve-month cut', async () => {
      // 1 January 2026 to 28 February 2027: the label is 2027, the end is the registry's.
      expect(await deadlineOf(2027, '2027-02-28')).toBe('2027-08-31');
    });

    it('30 June gives 31 December of the same year', async () => {
      expect(await deadlineOf(2026, '2026-06-30')).toBe('2026-12-31');
    });
  });

  it('counts a January-start company from its own year end', async () => {
    afsFor(2025, '2025-12-31');
    // Due 30 June 2026; 7 September 2026 is 31 + 31 + 7 = 69 days later.
    const [filing] = await getOverdueStatutoryFilings('c1', '2026-09-07');
    expect(filing).toEqual({
      filingType: 'Annual Financial Statements',
      fiscalYear: 2025,
      deadline: '2026-06-30',
      daysOverdue: 69,
    });
  });

  describe('a statement whose fiscal year no registry year carries', () => {
    // A March default would date a statement the company has no year for.
    // Refused by name instead, so no overdue count is invented.
    it('refuses rather than assuming a year end', async () => {
      afsFor(2026, null);
      await expect(getOverdueStatutoryFilings('c1', LONG_AFTER))
        .rejects.toBeInstanceOf(FilingDeadlineUnknownError);
    });

    it('asks the registry for THIS company and THIS label', async () => {
      afsFor(2026);
      await getOverdueStatutoryFilings('company-under-test', '2026-09-07');
      expect(getFiscalYearMock).toHaveBeenCalledWith('company-under-test', 2026);
    });
  });

  describe('the query', () => {
    it('is scoped to the company it was asked about', async () => {
      // The canned rows come back whatever is asked, so the tenant predicate
      // is checked where it is made: the value bound to `d.company_id`.
      afsFor(2026);
      await getOverdueStatutoryFilings('company-under-test', '2026-09-07');
      expect(boundAfter(/d\.company_id = $/)).toBe('company-under-test');
    });

    it('leaves out statements already signed off or filed', async () => {
      afsFor(2026);
      await getOverdueStatutoryFilings('c1', '2026-09-07');
      expect(theQuery().text).toMatch(/d\.status NOT IN \('signed_off', 'filed'\)/);
    });

    it('reads the sign-off as at the pack date, so a later sign-off does not clear an earlier pack', async () => {
      // Every writer that sets `signed_off` stamps `locked_at`. A pack dated
      // before that stamp was drawn while the statements were outstanding.
      afsFor(2026);
      await getOverdueStatutoryFilings('c1', '2026-09-07');
      expect(theQuery().text).toMatch(/OR \(d\.locked_at AT TIME ZONE 'Africa\/Johannesburg'\)::DATE > \$::DATE/);
      expect(boundAfter(/locked_at AT TIME ZONE 'Africa\/Johannesburg'\)::DATE > $/)).toBe('2026-09-07');
    });

    it('reads only annual financial statements that name a fiscal year', async () => {
      afsFor(2026);
      await getOverdueStatutoryFilings('c1', '2026-09-07');
      expect(theQuery().text).toMatch(/d\.document_type = 'afs'/);
      expect(theQuery().text).toMatch(/d\.fiscal_year IS NOT NULL/);
    });
  });

  it('lists the longest overdue first', async () => {
    afsFor(2026);
    sqlSpy.mockResolvedValue([{ fiscal_year: 2026 }, { fiscal_year: 2024 }]);
    const filings = await getOverdueStatutoryFilings('c1', '2026-09-07');
    expect(filings.map((f) => f.fiscalYear)).toEqual([2024, 2026]);
  });
});
