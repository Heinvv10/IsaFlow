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
vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({
  createFiscalYear: vi.fn(),
  getFiscalPeriodIdForDate: vi.fn(),
}));

import {
  createFiscalYear,
  getFiscalPeriodIdForDate,
} from '@/modules/accounting/services/gl/fiscalPeriodService';
import {
  AUTO_CREATE_YEARS_BACK,
  AUTO_CREATE_YEARS_FORWARD,
  isAutoCreatableYear,
  ensureFiscalPeriodForDate,
} from '@/modules/accounting/services/gl/fiscalPeriodAutoCreate';

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

describe('ensureFiscalPeriodForDate', () => {
  const lookup = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    lookup.mockReset();
  });

  it('returns the existing period without creating anything', async () => {
    lookup.mockResolvedValueOnce(PERIOD);
    const id = await ensureFiscalPeriodForDate(COMPANY, '2026-08-29', { lookup, today: TODAY });
    expect(id).toBe(PERIOD);
    expect(createFiscalYear).not.toHaveBeenCalled();
  });

  it('creates the year, then returns the period the second lookup finds', async () => {
    lookup.mockResolvedValueOnce(null).mockResolvedValueOnce(PERIOD);
    vi.mocked(createFiscalYear).mockResolvedValueOnce([] as never);

    const id = await ensureFiscalPeriodForDate(COMPANY, '2027-03-15', { lookup, today: TODAY });

    expect(createFiscalYear).toHaveBeenCalledWith(COMPANY, 2027);
    expect(id).toBe(PERIOD);
    // Re-read rather than trusting the create: the period id must come from the
    // same query the rest of the system uses.
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('takes the YEAR from the date string, not from today', async () => {
    lookup.mockResolvedValueOnce(null).mockResolvedValueOnce(PERIOD);
    vi.mocked(createFiscalYear).mockResolvedValueOnce([] as never);
    await ensureFiscalPeriodForDate(COMPANY, '2019-12-31', { lookup, today: TODAY });
    expect(createFiscalYear).toHaveBeenCalledWith(COMPANY, 2019);
  });

  it('returns NULL without creating when the year is outside the window', async () => {
    // Exactly today's behaviour for an absurd date — no worse, and no fiscal
    // year 9999 conjured out of a typo.
    lookup.mockResolvedValueOnce(null);
    const id = await ensureFiscalPeriodForDate(COMPANY, '9999-12-31', { lookup, today: TODAY });
    expect(id).toBeNull();
    expect(createFiscalYear).not.toHaveBeenCalled();
  });

  it('survives a concurrent creator that won the race', async () => {
    // Two requests posting into the same uncreated year: createFiscalYear
    // refuses the second with "already exists". That is success, not failure —
    // the period the other request created is exactly what we wanted.
    lookup.mockResolvedValueOnce(null).mockResolvedValueOnce(PERIOD);
    vi.mocked(createFiscalYear).mockRejectedValueOnce(new Error('Fiscal year 2027 already exists'));

    const id = await ensureFiscalPeriodForDate(COMPANY, '2027-03-15', { lookup, today: TODAY });
    expect(id).toBe(PERIOD);
  });

  it('does not swallow a REAL creation failure', async () => {
    // A permission error or a constraint violation is not a lost race, and
    // returning null would silently reinstate the NULL-period hole.
    lookup.mockResolvedValueOnce(null);
    vi.mocked(createFiscalYear).mockRejectedValueOnce(new Error('permission denied for table fiscal_periods'));

    await expect(
      ensureFiscalPeriodForDate(COMPANY, '2027-03-15', { lookup, today: TODAY }),
    ).rejects.toThrow(/permission denied/);
  });

  it('returns null rather than throwing when the year exists but still covers nothing', async () => {
    // Defensive: if the second lookup still misses, the caller gets the same
    // NULL it would have got before. Better a known-detectable NULL than a
    // throw on a path that used to succeed.
    lookup.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    vi.mocked(createFiscalYear).mockResolvedValueOnce([] as never);
    const id = await ensureFiscalPeriodForDate(COMPANY, '2027-03-15', { lookup, today: TODAY });
    expect(id).toBeNull();
  });

  it('uses the real period lookup when none is injected', async () => {
    // Every test above injects `lookup`, which would happily pass even if the
    // default pointed at a function that does not exist — the first draft of
    // this module imported a name that was never exported, and only tsc caught
    // it. This exercises the default path so the wiring is covered by a test
    // too.
    vi.mocked(getFiscalPeriodIdForDate).mockResolvedValueOnce(PERIOD);
    const id = await ensureFiscalPeriodForDate(COMPANY, '2026-08-29', { today: TODAY });
    expect(id).toBe(PERIOD);
    expect(getFiscalPeriodIdForDate).toHaveBeenCalledWith(COMPANY, '2026-08-29');
    expect(createFiscalYear).not.toHaveBeenCalled();
  });
});
