/**
 * `ensureFiscalPeriodForDate` derived the fiscal year from the first four
 * characters of the date string. That is the CALENDAR year, and on a March-start
 * company it is wrong for ten months out of twelve.
 *
 * The failure was silent and expensive: no period covers the date, the journal
 * posts with `fiscal_period_id` NULL, and it is then absent from the trial
 * balance, the VAT201 and the AFS — the same class of defect migration 501 was
 * written to clean up (Britech's R267,109.70 salary understatement).
 *
 * The module's own contract is unchanged and is the reason the failure paths
 * are tested as hard as the happy one: this runs on EVERY journal write, and
 * turning a post that succeeds today into a throw is the outcome it exists to
 * avoid.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({
  createFiscalYear: vi.fn(),
  getFiscalPeriodIdForDate: vi.fn(),
  resolveFiscalYearStartMonth: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  createFiscalYear,
  resolveFiscalYearStartMonth,
} from '@/modules/accounting/services/gl/fiscalPeriodService';
import { ensureFiscalPeriodForDate } from '@/modules/accounting/services/gl/fiscalPeriodAutoCreate';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TODAY = new Date(2026, 8, 3); // 3 September 2026

function alignment(startMonth: number) {
  return {
    declaredStartMonth: startMonth,
    observedStartMonth: startMonth,
    startMonth,
    aligned: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveFiscalYearStartMonth).mockResolvedValue(alignment(3));
  vi.mocked(createFiscalYear).mockResolvedValue([] as never);
});

describe('ensureFiscalPeriodForDate — fiscal year derivation', () => {
  it('creates the fiscal year the date falls in, not the calendar year', async () => {
    // 15 June 2026 on a March start is FY2027, not FY2026. Creating 2026 builds
    // Mar 2025 – Feb 2026 and still leaves the date uncovered.
    const lookup = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('period-id');

    const id = await ensureFiscalPeriodForDate(COMPANY, '2026-06-15', { lookup, today: TODAY });

    expect(createFiscalYear).toHaveBeenCalledWith(COMPANY, 2027);
    expect(id).toBe('period-id');
  });

  it('puts a February date in the year that ENDS in it', async () => {
    const lookup = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('p');
    await ensureFiscalPeriodForDate(COMPANY, '2026-02-20', { lookup, today: TODAY });
    expect(createFiscalYear).toHaveBeenCalledWith(COMPANY, 2026);
  });

  it('is the calendar year for a company whose periods start in January', async () => {
    vi.mocked(resolveFiscalYearStartMonth).mockResolvedValue(alignment(1));
    const lookup = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('p');
    await ensureFiscalPeriodForDate(COMPANY, '2026-06-15', { lookup, today: TODAY });
    expect(createFiscalYear).toHaveBeenCalledWith(COMPANY, 2026);
  });

  it('never reads the company row when the period already resolves', async () => {
    const lookup = vi.fn().mockResolvedValue('already-there');
    const id = await ensureFiscalPeriodForDate(COMPANY, '2026-06-15', { lookup, today: TODAY });
    expect(id).toBe('already-there');
    expect(resolveFiscalYearStartMonth).not.toHaveBeenCalled();
    expect(createFiscalYear).not.toHaveBeenCalled();
  });

  it('applies the auto-create window to the FISCAL year it derived', async () => {
    // 2014-06-15 on a March start is FY2015 — outside the ten-year window back
    // from 2026, so nothing is created and null comes back. Note the boundary
    // moves WITH the derivation: on the old calendar reading, 2015-06-15 was
    // year 2015 and refused, while its true fiscal year 2016 is inside the
    // window and is created.
    const lookup = vi.fn().mockResolvedValue(null);
    const id = await ensureFiscalPeriodForDate(COMPANY, '2014-06-15', { lookup, today: TODAY });
    expect(id).toBeNull();
    expect(createFiscalYear).not.toHaveBeenCalled();
  });

  it('returns null rather than throwing on a date it cannot parse', async () => {
    const lookup = vi.fn().mockResolvedValue(null);
    await expect(
      ensureFiscalPeriodForDate(COMPANY, 'not-a-date', { lookup, today: TODAY }),
    ).resolves.toBeNull();
    expect(createFiscalYear).not.toHaveBeenCalled();
  });

  it('still treats a lost creation race by OUTCOME, not by the error text', async () => {
    const lookup = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('winner-period');
    vi.mocked(createFiscalYear).mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value'), { code: '23505' }),
    );

    const id = await ensureFiscalPeriodForDate(COMPANY, '2026-06-15', { lookup, today: TODAY });

    expect(id).toBe('winner-period');
  });
});
