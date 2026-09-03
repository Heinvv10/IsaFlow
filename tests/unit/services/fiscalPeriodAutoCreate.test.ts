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
  resolveCompanyPeriodAlignment: vi.fn(),
}));

import {
  createFiscalYear,
  getFiscalPeriodIdForDate,
  resolveCompanyPeriodAlignment,
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
    // These cases predate fiscal alignment and assert the CALENDAR behaviour,
    // so they pin the company to a January start where the two coincide. The
    // March-start boundary is covered in ensureFiscalPeriodAlignment.test.ts.
    vi.mocked(resolveCompanyPeriodAlignment).mockResolvedValue({
      declaredStartMonth: 1, observedStartMonth: 1, startMonth: 1, aligned: true,
    });
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

  /**
   * Losing the race is decided by the OUTCOME, never by the error's text.
   *
   * The first version of this matched `/already exists/i`, and its test mocked
   * exactly that string — which is the message `createFiscalYear`'s own
   * pre-check SELECT throws. But in a REAL race both pre-checks pass before
   * either commits, and the loser's INSERT dies on
   * `uq_fiscal_periods_company_year_period` with a raw Postgres 23505 whose
   * message says "duplicate key value violates unique constraint". That does
   * not match, so the very case the test claimed to cover would have 500'd —
   * worse than the silent NULL it replaced, because the loser's journal is
   * perfectly valid and its period now exists.
   *
   * This codebase learned the same lesson once already, for invoice numbers:
   * "Detection must key on SQLSTATE 23505 — pg localises/rewords messages"
   * (customerInvoiceCreateRetry.test.ts). Rather than enumerate SQLSTATEs,
   * ensureFiscalPeriodForDate now asks the only question that matters: after
   * the failure, does the period exist? If yes, someone created it and we are
   * done. If no, the failure was real.
   */
  it('survives a raw 23505 from the losing INSERT in a real race', async () => {
    lookup.mockResolvedValueOnce(null).mockResolvedValueOnce(PERIOD);
    const dup = Object.assign(
      new Error('duplicate key value violates unique constraint "uq_fiscal_periods_company_year_period"'),
      { code: '23505' },
    );
    vi.mocked(createFiscalYear).mockRejectedValueOnce(dup);

    const id = await ensureFiscalPeriodForDate(COMPANY, '2027-03-15', { lookup, today: TODAY });
    expect(id).toBe(PERIOD);
  });

  it('survives a 23P01 exclusion-constraint violation the same way', async () => {
    // fiscal_periods carries an EXCLUDE constraint (migration 502). An overlap
    // raises 23P01, whose message shares no wording with 23505 — another reason
    // not to enumerate error shapes.
    lookup.mockResolvedValueOnce(null).mockResolvedValueOnce(PERIOD);
    const overlap = Object.assign(
      new Error('conflicting key value violates exclusion constraint "fiscal_periods_no_overlap"'),
      { code: '23P01' },
    );
    vi.mocked(createFiscalYear).mockRejectedValueOnce(overlap);

    const id = await ensureFiscalPeriodForDate(COMPANY, '2027-03-15', { lookup, today: TODAY });
    expect(id).toBe(PERIOD);
  });

  it("survives createFiscalYear's own pre-check message too", async () => {
    // The app-level path: the pre-check SELECT sees the year and refuses before
    // inserting anything. Still a lost race, still success.
    lookup.mockResolvedValueOnce(null).mockResolvedValueOnce(PERIOD);
    vi.mocked(createFiscalYear).mockRejectedValueOnce(new Error('Fiscal year 2027 already exists'));

    const id = await ensureFiscalPeriodForDate(COMPANY, '2027-03-15', { lookup, today: TODAY });
    expect(id).toBe(PERIOD);
  });

  it('does not swallow a REAL creation failure — no period afterwards', async () => {
    // A permission error leaves no period behind, so the re-read still misses
    // and the original error must surface. Returning null would silently
    // reinstate the NULL-period hole this whole module exists to close.
    lookup.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    vi.mocked(createFiscalYear).mockRejectedValueOnce(
      Object.assign(new Error('permission denied for table fiscal_periods'), { code: '42501' }),
    );

    await expect(
      ensureFiscalPeriodForDate(COMPANY, '2027-03-15', { lookup, today: TODAY }),
    ).rejects.toThrow(/permission denied/);
  });

  it('rethrows the ORIGINAL error, not a generic one, so the cause survives', async () => {
    lookup.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const original = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    vi.mocked(createFiscalYear).mockRejectedValueOnce(original);

    await expect(
      ensureFiscalPeriodForDate(COMPANY, '2027-03-15', { lookup, today: TODAY }),
    ).rejects.toBe(original);
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
