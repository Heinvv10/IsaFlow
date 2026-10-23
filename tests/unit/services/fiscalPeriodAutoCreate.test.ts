/**
 * A journal date should land in a fiscal period, not outside every one of them.
 *
 * The gap: `createJournalEntry` resolves the covering `fiscal_periods` row and,
 * finding none, INSERTs `fiscal_period_id = NULL`. `postJournalEntry` guards its
 * closed-period check behind `if (entry.fiscalPeriodId)`, so a NULL period skips
 * it and the entry POSTS — permanently outside the trial balance, the VAT201 and
 * the AFS. That is not hypothetical: migration 501 names Britech's
 * R267,109.70 salary understatement as exactly this, with 200+ more rows at the
 * time. Those were backfilled (production is at zero today) and integrity check
 * #9 gates every deploy, but the code path is still open.
 *
 * The ROOT CAUSE is not that createJournalEntry is permissive — it is that the
 * periods do not exist. `createFiscalYear` is called from exactly one manual
 * admin endpoint; nothing creates periods when a company is provisioned, and
 * there is no "create N years ahead". So a brand-new company has ZERO periods
 * and every date falls outside.
 *
 * Fixing it by making createJournalEntry THROW would break real flows — bulk
 * imports of historical data, payroll for a year nobody has created yet, and
 * every `new Date()` caller in the first days of an uncreated fiscal year.
 * Creating the period instead breaks nothing and removes the reason dates fall
 * outside at all.
 *
 * The BOUND is the part that needs care. Auto-creating any year a date names
 * would happily build fiscal year 9999 out of a typo. So creation is limited to
 * a window around today, and a date outside it still resolves to NULL exactly as
 * before — no worse than today, and the reversal guard and the deploy-gating
 * integrity check both still catch it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
// The one query of its own: does the generated year hold a closed or locked period?
const holdsClosed = vi.hoisted(() => ({ rows: [{ x: 1 }] as unknown[] }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => holdsClosed.rows) }));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({
  getFiscalPeriodIdForDate: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', () => ({
  fiscalYearForDate: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/fiscalYearGenerator', () => ({
  generateFiscalYearForDate: vi.fn(),
}));

import { getFiscalPeriodIdForDate } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { fiscalYearForDate, type FiscalYearRecord } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';
import {
  AUTO_CREATE_YEARS_BACK,
  AUTO_CREATE_YEARS_FORWARD,
  isAutoCreatableYear,
  isOutsideWindowByCalendarYear,
  ensureFiscalPeriodForDate,
  FiscalPeriodNotGeneratedError,
} from '@/modules/accounting/services/gl/fiscalPeriodAutoCreate';
import { ClosedFiscalPeriodError } from '@/modules/accounting/services/gl/journalEntryPostingGuards';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const PERIOD = 'pppppppp-0000-4000-8000-pppppppppppp';

/** A fixed "today" so the window assertions do not drift with the wall clock. */
const TODAY = new Date(2026, 7, 29); // 2026-08-29, local

describe('isAutoCreatableYear — the bound', () => {
  it('allows the current year', () => {
    expect(isAutoCreatableYear(2026, TODAY)).toBe(true);
  });

  it('allows historical years within the window, so an import of old books works', () => {
    // The real statements this repo carries start in 2018 — eight years back.
    expect(isAutoCreatableYear(2018, TODAY)).toBe(true);
    expect(isAutoCreatableYear(2026 - AUTO_CREATE_YEARS_BACK, TODAY)).toBe(true);
  });

  it('allows the next year, so year-end and next-period payroll do not stall', () => {
    expect(isAutoCreatableYear(2027, TODAY)).toBe(true);
    expect(isAutoCreatableYear(2026 + AUTO_CREATE_YEARS_FORWARD, TODAY)).toBe(true);
  });

  it('REFUSES a year outside the window — a typo must not build a fiscal year', () => {
    expect(isAutoCreatableYear(9999, TODAY)).toBe(false);
    expect(isAutoCreatableYear(1, TODAY)).toBe(false);
    expect(isAutoCreatableYear(2026 - AUTO_CREATE_YEARS_BACK - 1, TODAY)).toBe(false);
    expect(isAutoCreatableYear(2026 + AUTO_CREATE_YEARS_FORWARD + 1, TODAY)).toBe(false);
  });
});

const year = (over: Partial<FiscalYearRecord> = {}): FiscalYearRecord => ({
  id: null, fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28', status: 'open',
  kind: 'normal', stored: false, months: 12, ...over,
});

describe('isOutsideWindowByCalendarYear — decided without the registry', () => {
  it('is true only when neither the calendar year nor the next one is in the window', () => {
    expect(isOutsideWindowByCalendarYear('9999-12-31', TODAY)).toBe(true);
    expect(isOutsideWindowByCalendarYear(`${2026 + AUTO_CREATE_YEARS_FORWARD + 1}-01-01`, TODAY)).toBe(true);
    expect(isOutsideWindowByCalendarYear(`${2026 + AUTO_CREATE_YEARS_FORWARD}-12-31`, TODAY)).toBe(false);
    // A date one year before the window can sit in a year labelled for the next calendar year.
    expect(isOutsideWindowByCalendarYear(`${2026 - AUTO_CREATE_YEARS_BACK - 1}-06-01`, TODAY)).toBe(false);
    expect(isOutsideWindowByCalendarYear(`${2026 - AUTO_CREATE_YEARS_BACK - 2}-06-01`, TODAY)).toBe(true);
    expect(isOutsideWindowByCalendarYear('not-a-date', TODAY)).toBe(false);
  });
});

describe('ensureFiscalPeriodForDate', () => {
  const lookup = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    lookup.mockReset();
    vi.mocked(fiscalYearForDate).mockResolvedValue(year());
    vi.mocked(generateFiscalYearForDate).mockResolvedValue({ fiscalYearId: 'y1', periodsCreated: 12 });
  });

  it('returns the existing period without resolving or generating anything', async () => {
    lookup.mockResolvedValueOnce(PERIOD);
    expect(await ensureFiscalPeriodForDate(COMPANY, '2026-08-29', { lookup, today: TODAY })).toBe(PERIOD);
    expect(fiscalYearForDate).not.toHaveBeenCalled();
    expect(generateFiscalYearForDate).not.toHaveBeenCalled();
  });

  it('generates the year holding the date, then returns what the second lookup finds', async () => {
    lookup.mockResolvedValueOnce(null).mockResolvedValueOnce(PERIOD);
    expect(await ensureFiscalPeriodForDate(COMPANY, '2027-01-15', { lookup, today: TODAY })).toBe(PERIOD);
    expect(fiscalYearForDate).toHaveBeenCalledWith(COMPANY, '2027-01-15');
    expect(generateFiscalYearForDate).toHaveBeenCalledWith(COMPANY, '2027-01-15');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('applies the window to the FISCAL year label the registry gives, not the calendar year', async () => {
    lookup.mockResolvedValue(null);
    vi.mocked(fiscalYearForDate).mockResolvedValueOnce(year({ fiscalYear: 2026 + AUTO_CREATE_YEARS_FORWARD + 1 }));
    expect(await ensureFiscalPeriodForDate(COMPANY, '2026-12-01', { lookup, today: TODAY })).toBeNull();
    expect(generateFiscalYearForDate).not.toHaveBeenCalled();
  });

  it('returns null without generating when the year is outside the window', async () => {
    lookup.mockResolvedValue(null);
    expect(await ensureFiscalPeriodForDate(COMPANY, '9999-01-01', { lookup, today: TODAY })).toBeNull();
    expect(generateFiscalYearForDate).not.toHaveBeenCalled();
    // Decided by the calendar year: the registry's template raises for a date this far
    // from the stored years, and that error would abort the caller's transaction.
    expect(fiscalYearForDate).not.toHaveBeenCalled();
  });

  it.each(['closed', 'locked'] as const)('returns null without generating when the year is %s', async (status) => {
    lookup.mockResolvedValue(null);
    vi.mocked(fiscalYearForDate).mockResolvedValueOnce(year({ status, stored: true, id: 'y0' }));
    expect(await ensureFiscalPeriodForDate(COMPANY, '2026-05-01', { lookup, today: TODAY })).toBeNull();
    expect(generateFiscalYearForDate).not.toHaveBeenCalled();
  });

  it('returns null rather than throwing when the year cannot be resolved (bad date, company gone)', async () => {
    lookup.mockResolvedValue(null);
    vi.mocked(fiscalYearForDate).mockRejectedValueOnce(new Error('invalid input syntax for type date'));
    expect(await ensureFiscalPeriodForDate(COMPANY, 'not-a-date', { lookup, today: TODAY })).toBeNull();
    expect(generateFiscalYearForDate).not.toHaveBeenCalled();
  });

  it('does not swallow a real generator failure', async () => {
    lookup.mockResolvedValue(null);
    vi.mocked(generateFiscalYearForDate).mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '42501' }));
    await expect(ensureFiscalPeriodForDate(COMPANY, '2026-05-01', { lookup, today: TODAY })).rejects.toThrow('boom');
  });

  // A null here is stored as fiscal_period_id NULL and posts past the closed-period
  // check, outside every period-bounded report (the R267k hole this module closes).
  it('REFUSES when the generator still leaves the date uncovered (a month beside closed periods)', async () => {
    lookup.mockResolvedValue(null);
    vi.mocked(generateFiscalYearForDate).mockResolvedValueOnce({ fiscalYearId: 'y1', periodsCreated: 0 });
    const err = await ensureFiscalPeriodForDate(COMPANY, '2026-05-01', { lookup, today: TODAY }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FiscalPeriodNotGeneratedError);
    expect(err).toBeInstanceOf(ClosedFiscalPeriodError);
    expect((err as Error).message).toMatch(/No fiscal period covers 2026-05-01.*FY2027 already holds closed or locked periods/);
  });

  it('names a part month at the year edge when the year holds no closed period', async () => {
    lookup.mockResolvedValue(null);
    vi.mocked(generateFiscalYearForDate).mockResolvedValueOnce({ fiscalYearId: 'y1', periodsCreated: 0 });
    holdsClosed.rows = [];
    try {
      const err = await ensureFiscalPeriodForDate(COMPANY, '2026-05-01', { lookup, today: TODAY }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FiscalPeriodNotGeneratedError);
      expect((err as Error).message).toMatch(/2026-05-01.*part month at the edge of fiscal year FY2027 \(2026-03-01 to 2027-02-28\)/);
    } finally {
      holdsClosed.rows = [{ x: 1 }];
    }
  });

  it('uses the real period lookup when none is injected', async () => {
    vi.mocked(getFiscalPeriodIdForDate).mockResolvedValueOnce(PERIOD);
    expect(await ensureFiscalPeriodForDate(COMPANY, '2026-08-29')).toBe(PERIOD);
    expect(getFiscalPeriodIdForDate).toHaveBeenCalledWith(COMPANY, '2026-08-29');
  });
});
