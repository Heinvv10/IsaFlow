/**
 * The fiscal-period verdict, and the trap it exists to avoid.
 *
 * The obvious guard — "no period covers this date, so skip it" — is WRONG in
 * the other direction, and that is the failure this file pins. `createJournalEntry`
 * calls `ensureFiscalPeriodForDate`, which CREATES the fiscal year on demand
 * inside a bounded window around today. An invoice dated in an uncreated but
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
vi.mock('@/modules/accounting/services/gl/fiscalYearCreateService', () => ({
  resolveCompanyPeriodAlignment: vi.fn(),
}));

import { sql } from '@/lib/neon';
import {
  resolveCompanyPeriodAlignment,
} from '@/modules/accounting/services/gl/fiscalYearCreateService';
import { resolvePeriodSkips } from '@/lib/mcp/tools/bulkApprovePeriods';

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
  vi.mocked(resolveCompanyPeriodAlignment).mockResolvedValue({ startMonth: 1 } as never);
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

  it('does not resolve the company alignment when every date is covered', async () => {
    periods({ start: '2026-09-01', end: '2026-09-30', status: 'open' });
    await resolvePeriodSkips(COMPANY, ['2026-09-15']);
    expect(resolveCompanyPeriodAlignment).not.toHaveBeenCalled();
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
   * A March-start company: a June 2026 date belongs to FY2027, not FY2026.
   * Testing the CALENDAR year against the window is wrong for ten months of
   * twelve, which is why the fiscal year is resolved from the alignment.
   */
  it('tests the FISCAL year against the window, not the calendar year', async () => {
    vi.mocked(resolveCompanyPeriodAlignment).mockResolvedValue({ startMonth: 3 } as never);
    periods();
    await resolvePeriodSkips(COMPANY, ['2026-06-15']);
    expect(resolveCompanyPeriodAlignment).toHaveBeenCalledWith(COMPANY);
  });
});
