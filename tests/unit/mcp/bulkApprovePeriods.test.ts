/**
 * The fiscal-period verdict, and the trap it exists to avoid.
 *
 * The obvious guard — "no period covers this date, so skip it" — is WRONG in
 * the other direction, and that is the failure this file pins. `createJournalEntry`
 * calls `ensureFiscalPeriodForDate`, which CREATES the date's period on demand
 * when its fiscal year is inside a bounded window around today and not closed. An invoice dated in an uncreated but
 * creatable year posts perfectly well through the single tool; skipping it in
 * the batch would refuse work the single tool performs, and a historical
 * subledger reload is exactly the caller that names uncreated years.
 *
 * So three verdicts are asserted, not two — and the two SKIP cases are asserted
 * to be distinguishable, because "closed period, reopen it" and "no period at
 * all, create the year" are different actions for the agent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
// The fiscal year of an uncovered date is the registry's (stored year, else the template).
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry',
  async () => (await import('../../helpers/fiscalYearSqlFake')).registryMock());

import { sql } from '@/lib/neon';
import { fiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { resolvePeriodSkips } from '@/lib/mcp/tools/bulkApprovePeriods';
import { fakeRegistry, resetFakeRegistry } from '../../helpers/fiscalYearSqlFake';

const COMPANY = 'company-1';

/** `fiscal_periods` rows as pg returns them — DATE columns come back as Date
 *  objects, which is the shape the UTC-rollback bug hides in. */
function periods(...rows: { start: string; end: string; status: string }[]) {
  vi.mocked(sql).mockResolvedValue(rows.map((r) => ({
    start_date: r.start, end_date: r.end, status: r.status,
  })) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFakeRegistry();
  // A calendar-year company: the template is January, so a date's fiscal year is its calendar year.
  fakeRegistry.templateMonth = 1;
});

describe('resolvePeriodSkips', () => {
  it('passes a date inside an OPEN period', async () => {
    periods({ start: '2026-09-01', end: '2026-09-30', status: 'open' });
    const v = await resolvePeriodSkips(COMPANY, ['2026-09-15']);
    expect(v.get('2026-09-15')).toBeNull();
  });

  it('skips a date inside a CLOSED period, naming the status and the date', async () => {
    periods({ start: '2026-08-01', end: '2026-08-31', status: 'closed' });
    const reason = (await resolvePeriodSkips(COMPANY, ['2026-08-15'])).get('2026-08-15');
    expect(reason).toContain('2026-08-15');
    expect(reason).toContain('closed');
  });

  it('skips a LOCKED period too — postJournalEntry admits only "open"', async () => {
    periods({ start: '2026-07-01', end: '2026-07-31', status: 'locked' });
    expect((await resolvePeriodSkips(COMPANY, ['2026-07-10'])).get('2026-07-10'))
      .toContain('locked');
  });

  /**
   * The trap. No period covers 2025 here, but 2025 is inside the auto-create
   * window, so `ensureFiscalPeriodForDate` will build it and the journal posts.
   * A guard that skipped on "no covering period" would refuse a document the
   * single tool approves without complaint.
   */
  it('PASSES a date with no covering period when the year is auto-creatable', async () => {
    periods({ start: '2026-01-01', end: '2026-12-31', status: 'open' });
    expect((await resolvePeriodSkips(COMPANY, ['2025-06-15'])).get('2025-06-15')).toBeNull();
  });

  /**
   * The other half of the same guard: outside the window nothing is created,
   * `createJournalEntry` stores fiscal_period_id NULL, and postJournalEntry's
   * closed-period check is skipped entirely — so the entry POSTS, invisible to
   * the trial balance, the VAT201 and the AFS.
   */
  it('SKIPS a date whose year is outside the auto-create window', async () => {
    periods({ start: '2026-01-01', end: '2026-12-31', status: 'open' });
    const reason = (await resolvePeriodSkips(COMPANY, ['1999-06-15'])).get('1999-06-15');
    expect(reason).toContain('1999');
    expect(reason).toContain('outside the trial balance');
  });

  it('distinguishes the two skips — an agent must know whether to reopen or create', async () => {
    periods({ start: '2026-08-01', end: '2026-08-31', status: 'closed' });
    const v = await resolvePeriodSkips(COMPANY, ['2026-08-15', '1999-06-15']);
    expect(v.get('2026-08-15')).toContain('reopen it');
    expect(v.get('1999-06-15')).toContain('create the year');
  });

  it('reads the period table ONCE for the whole batch', async () => {
    periods({ start: '2026-09-01', end: '2026-09-30', status: 'open' });
    await resolvePeriodSkips(COMPANY, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
  });

  it('does not ask the registry when every date is covered', async () => {
    periods({ start: '2026-09-01', end: '2026-09-30', status: 'open' });
    await resolvePeriodSkips(COMPANY, ['2026-09-15']);
    expect(fiscalYearForDate).not.toHaveBeenCalled();
  });

  /**
   * pg hands DATE columns back as Date objects at LOCAL midnight. Under
   * toISOString() on this UTC+2 server that rolls BACK a day, so a document
   * dated the 1st would be matched against the previous month's period — the
   * exact bug getFiscalPeriodIdForDate documents. Both sides go through
   * fmtDate, so a Date and its string spelling must agree.
   */
  it('matches a Date at local midnight to the same period as its string form', async () => {
    periods({ start: '2026-09-01', end: '2026-09-30', status: 'open' },
            { start: '2026-08-01', end: '2026-08-31', status: 'closed' });
    const v = await resolvePeriodSkips(COMPANY, [new Date(2026, 8, 1)]);
    expect(v.get('2026-09-01')).toBeNull();
  });

  it('is empty for an empty batch and reads nothing', async () => {
    const v = await resolvePeriodSkips(COMPANY, []);
    expect(v.size).toBe(0);
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });

  /**
   * A March-start company: a June 2028 date belongs to FY2029, not FY2028.
   * Testing the CALENDAR year against the window (today + 2 years) is wrong for
   * ten months of twelve, which is why the registry's fiscal year is tested.
   */
  it('tests the FISCAL year against the window, not the calendar year', async () => {
    fakeRegistry.templateMonth = 3;
    periods();
    const v = await resolvePeriodSkips(COMPANY, ['2028-01-15', '2028-06-15']);
    expect(v.get('2028-01-15')).toBeNull();            // FY2028: inside the window
    expect(v.get('2028-06-15')).toContain('fiscal year 2029');   // FY2029: outside it
  });

  /**
   * ensureFiscalPeriodForDate now fills a gap inside an EXISTING open year (the
   * old rule refused it as "year already exists"), so the batch must pass it.
   */
  it('PASSES a date in a GAP of an existing open year', async () => {
    fakeRegistry.years = [{ fiscalYear: 2026, startDate: '2026-01-01', endDate: '2026-12-31' }];
    periods({ start: '2026-01-01', end: '2026-01-31', status: 'open' },
            { start: '2026-03-01', end: '2026-12-31', status: 'open' });
    expect((await resolvePeriodSkips(COMPANY, ['2026-02-10'])).get('2026-02-10')).toBeNull();
  });

  it('SKIPS a date in a gap of a CLOSED year, naming the status', async () => {
    fakeRegistry.years = [{ fiscalYear: 2026, startDate: '2026-01-01', endDate: '2026-12-31', status: 'closed' }];
    periods({ start: '2026-03-01', end: '2026-12-31', status: 'closed' });
    const reason = (await resolvePeriodSkips(COMPANY, ['2026-02-10'])).get('2026-02-10');
    expect(reason).toContain('fiscal year 2026 is closed');
    expect(reason).toContain('reopen it');
  });

  it('SKIPS a date that is not a real date without asking the registry (its cast would poison the transaction)', async () => {
    periods();
    const reason = (await resolvePeriodSkips(COMPANY, ['2026-02-30'])).get('2026-02-30');
    expect(reason).toContain('not a valid date');
    expect(fiscalYearForDate).not.toHaveBeenCalled();
  });
});
