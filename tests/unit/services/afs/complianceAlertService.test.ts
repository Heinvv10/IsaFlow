// tests/unit/services/afs/complianceAlertService.test.ts
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
// The deadline's year end is the registry year's, not a start month re-applied.
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', () => ({ getFiscalYear: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getFiscalYear } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import {
  createAfsAlert,
  getActiveAfsAlerts,
  dismissAfsAlert,
  detectAndFireAfsAlerts,
} from '@/modules/accounting/services/afs/complianceAlertService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ALERT_ID = '99999999-8888-7777-6666-555555555555';
const USER_ID  = 'cccccccc-dddd-eeee-ffff-000000000001';

describe('complianceAlertService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('createAfsAlert', () => {
    it('calls INSERT ... ON CONFLICT DO NOTHING (idempotent)', async () => {
      mockSql.mockResolvedValueOnce([]);

      await createAfsAlert(
        COMPANY,
        'pis_threshold_100',
        'PIS has crossed 100',
        'warning',
        'Previous: 90, Current: 105'
      );

      expect(mockSql).toHaveBeenCalledTimes(1);
      // Verify the ON CONFLICT pattern is used (the sql tag is called with the INSERT)
      const callArgs = mockSql.mock.calls[0];
      // callArgs[0] is the TemplateStringsArray — check the combined SQL string
      const sqlParts = (callArgs?.[0] as string[]).join('');
      expect(sqlParts.toLowerCase()).toContain('on conflict');
      expect(sqlParts.toLowerCase()).toContain('do nothing');
    });

    it('does not throw when called twice for the same alert type (idempotent)', async () => {
      mockSql.mockResolvedValue([]);

      await createAfsAlert(COMPANY, 'pis_threshold_100', 'msg', 'warning');
      await createAfsAlert(COMPANY, 'pis_threshold_100', 'msg', 'warning');

      // Both calls succeed; uniqueness enforced by DB partial index
      expect(mockSql).toHaveBeenCalledTimes(2);
    });
  });

  describe('getActiveAfsAlerts', () => {
    it('returns mapped alert objects with ISO timestamps', async () => {
      const firedDate = new Date('2026-04-16T10:00:00Z');
      mockSql.mockResolvedValueOnce([
        {
          id: ALERT_ID,
          company_id: COMPANY,
          alert_type: 'afs_filing_deadline_30',
          message: 'Filing deadline approaching',
          detail: 'Deadline: 2026-08-28',
          fired_at: firedDate,
          dismissed_at: null,
          dismissed_by: null,
        },
      ]);

      const alerts = await getActiveAfsAlerts(COMPANY);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.id).toBe(ALERT_ID);
      expect(alerts[0]?.alertType).toBe('afs_filing_deadline_30');
      expect(alerts[0]?.message).toBe('Filing deadline approaching');
      expect(alerts[0]?.detail).toBe('Deadline: 2026-08-28');
      expect(alerts[0]?.firedAt).toBe('2026-04-16T10:00:00.000Z');
      expect(alerts[0]?.dismissedAt).toBeNull();
    });

    it('filters out dismissed alerts via SQL WHERE dismissed_at IS NULL', async () => {
      // Return only undismissed rows (DB query already filters)
      mockSql.mockResolvedValueOnce([]);

      const alerts = await getActiveAfsAlerts(COMPANY);

      expect(alerts).toHaveLength(0);
      const sqlParts = (mockSql.mock.calls[0]?.[0] as string[]).join('');
      expect(sqlParts.toLowerCase()).toContain('dismissed_at is null');
    });

    it('handles string fired_at (non-Date) gracefully', async () => {
      mockSql.mockResolvedValueOnce([
        {
          id: ALERT_ID,
          company_id: COMPANY,
          alert_type: 'pis_threshold_350',
          message: 'PIS crossed 350',
          detail: null,
          fired_at: '2026-04-10T08:00:00Z',
          dismissed_at: null,
          dismissed_by: null,
        },
      ]);

      const alerts = await getActiveAfsAlerts(COMPANY);
      expect(alerts[0]?.firedAt).toBe('2026-04-10T08:00:00Z');
      expect(alerts[0]?.detail).toBeUndefined();
    });
  });

  describe('dismissAfsAlert', () => {
    it('calls UPDATE with dismissed_at = now() and dismissed_by', async () => {
      mockSql.mockResolvedValueOnce([]);

      await dismissAfsAlert(COMPANY, ALERT_ID, USER_ID);

      expect(mockSql).toHaveBeenCalledTimes(1);
      const sqlParts = (mockSql.mock.calls[0]?.[0] as string[]).join('');
      expect(sqlParts.toLowerCase()).toContain('dismissed_at');
      expect(sqlParts.toLowerCase()).toContain('dismissed_by');
    });

    it('includes company_id in WHERE clause (tenant scoping)', async () => {
      mockSql.mockResolvedValueOnce([]);

      await dismissAfsAlert(COMPANY, ALERT_ID, USER_ID);

      const sqlParts = (mockSql.mock.calls[0]?.[0] as string[]).join('');
      expect(sqlParts.toLowerCase()).toContain('company_id');
    });
  });
});

/**
 * THE APPROACHING-DEADLINE ALERT USES THE SAME DEADLINE AS THE BOARD PACK.
 *
 * This detector had its own copy of "year end plus six months" —
 * `setMonth(getMonth() + 6)` on a month-end, which keeps the day number and
 * overflows: a 31 March year end gave 1 October, 31 December gave 1 July, 31
 * August gave 3 March, 28 February stopped at 28 August — and its own
 * `|| 3`, which dated a tenant with no financial year start as if it were a
 * February year end. The rule lives in `afsFilingDeadline.ts` now and both
 * this detector and `statutoryFilingsService` read it.
 */
describe('detectAndFireAfsAlerts — the AFS filing deadline', () => {
  /** The filing-deadline alerts the detector inserted: [alert_type, message, detail]. */
  async function alertsFor(
    today: string,
    documents: Array<{ fiscal_year: number; yearEnd: string | null }>,
  ): Promise<Array<[string, string, string]>> {
    mockSql.mockReset();
    mockSql.mockImplementation(async (strings: unknown) => {
      const text = (strings as readonly string[]).join('?');
      if (text.includes('d.fiscal_year')) return documents.map((d) => ({ fiscal_year: d.fiscal_year }));
      return [];
    });
    // The registry year with each label: its end, or none (null).
    vi.mocked(getFiscalYear).mockImplementation(async (_companyId, label) => {
      const end = documents.find((d) => d.fiscal_year === label)?.yearEnd;
      return end ? { id: 'fy', fiscalYear: label, startDate: '2000-01-01', endDate: end, status: 'open', kind: 'normal', stored: true, months: 12 } : null;
    });
    vi.useFakeTimers();
    // Midday SAST on `today`, so the calendar day is not in doubt.
    vi.setSystemTime(new Date(`${today}T10:00:00.000Z`));
    try {
      await detectAndFireAfsAlerts('company-1');
    } finally {
      vi.useRealTimers();
    }
    return mockSql.mock.calls
      .filter(([strings]) => (strings as readonly string[]).join('?').includes('INSERT INTO compliance_alerts'))
      .map((call) => [call[2], call[3], call[4]] as [string, string, string]);
  }

  it.each([
    ['28 February', 2026, '2026-02-28', '2026-08-31'],
    ['29 February in a leap year', 2028, '2028-02-29', '2028-08-31'],
    ['31 March', 2026, '2026-03-31', '2026-09-30'],
    ['31 August', 2025, '2025-08-31', '2026-02-28'],
    ['31 December', 2025, '2025-12-31', '2026-06-30'],
    ['30 June', 2026, '2026-06-30', '2026-12-31'],
    ['28 February ending a 14-month transition year', 2027, '2027-02-28', '2027-08-31'],
  ])('a %s year end is due on the last day of the sixth month after it', async (_what, fiscalYear, yearEnd, deadline) => {
    // Ten days before the deadline, counted on the calendar.
    const [y, m, d] = deadline.split('-').map(Number);
    const today = new Date(Date.UTC(y!, m! - 1, d! - 10)).toISOString().slice(0, 10);
    const alerts = await alertsFor(today, [{ fiscal_year: fiscalYear, yearEnd }]);
    expect(alerts).toEqual([
      ['afs_filing_deadline_14', 'AFS filing deadline is in 10 day(s)', `Deadline: ${deadline}`],
    ]);
  });

  it('counts whole calendar days, and picks the alert band from them', async () => {
    const doc = [{ fiscal_year: 2026, yearEnd: '2026-02-28' }]; // due 2026-08-31
    expect((await alertsFor('2026-08-24', doc))[0]).toEqual(
      ['afs_filing_deadline_7', 'AFS filing deadline is in 7 day(s)', 'Deadline: 2026-08-31']);
    expect((await alertsFor('2026-08-23', doc))[0]![0]).toBe('afs_filing_deadline_14');
    expect((await alertsFor('2026-08-01', doc))[0]).toEqual(
      ['afs_filing_deadline_30', 'AFS filing deadline is approaching — 30 day(s) remaining', 'Deadline: 2026-08-31']);
    expect(await alertsFor('2026-07-31', doc)).toEqual([]);
  });

  it('says a deadline has passed rather than that it is in a negative number of days', async () => {
    const [alert] = await alertsFor('2026-09-07', [{ fiscal_year: 2026, yearEnd: '2026-02-28' }]);
    expect(alert).toEqual(['afs_filing_deadline_7', 'AFS filing deadline passed 7 day(s) ago', 'Deadline: 2026-08-31']);
  });

  const UNKNOWN: [string, string, string] = [
    'afs_filing_deadline_unknown',
    'AFS filing deadline cannot be assessed: the financial year start is not set',
    'Set the financial year start in Company Settings. Until then no filing deadline reminder can be raised.',
  ];

  it('says the deadline cannot be assessed for a statement whose fiscal year no registry year carries', async () => {
    vi.mocked(log.warn).mockClear();
    const alerts = await alertsFor('2026-08-25', [{ fiscal_year: 2026, yearEnd: null }]);
    // It used to assume March and fire "deadline is in 3 day(s)" off it; then
    // it fired nothing and told only the server log, so the reader saw a
    // clean alert list for a company whose deadline nobody had checked.
    expect(alerts).toEqual([UNKNOWN]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls[0])).toMatch(/no financial year with this label/);
  });

  it('raises that alert once for the company, however many statements are open', async () => {
    const alerts = await alertsFor('2026-08-25', [
      { fiscal_year: 2025, yearEnd: null },
      { fiscal_year: 2026, yearEnd: null },
    ]);
    expect(alerts).toEqual([UNKNOWN]);
  });

  it('raises nothing of the kind for a statement whose year resolves', async () => {
    const alerts = await alertsFor('2026-08-25', [{ fiscal_year: 2026, yearEnd: '2026-02-28' }]);
    expect(alerts.map((a) => a[0])).toEqual(['afs_filing_deadline_7']);
  });

  /** The withdrawals the detector issued in its last run: [company, alert_type]. */
  const withdrawals = () => mockSql.mock.calls
    .filter(([strings]) => /UPDATE compliance_alerts\s+SET dismissed_at/.test((strings as readonly string[]).join('?')))
    .map((call) => [call[1], call[2]]);

  it('withdraws that alert once the year resolves, for this company only', async () => {
    await alertsFor('2026-08-25', [{ fiscal_year: 2026, yearEnd: '2026-02-28' }]);
    expect(withdrawals()).toEqual([['company-1', 'afs_filing_deadline_unknown']]);
  });

  it('withdraws it when no statement is left open to assess', async () => {
    await alertsFor('2026-08-25', []);
    expect(withdrawals()).toEqual([['company-1', 'afs_filing_deadline_unknown']]);
  });

  it('does not withdraw it in the run that raises it', async () => {
    await alertsFor('2026-08-25', [{ fiscal_year: 2026, yearEnd: null }]);
    expect(withdrawals()).toEqual([]);
  });

  it('still alerts for the company\'s other statements when one has no registry year', async () => {
    // Rows are per document; the detector must not let one bad row stop the loop.
    const alerts = await alertsFor('2026-08-25', [
      { fiscal_year: 2025, yearEnd: null },
      { fiscal_year: 2026, yearEnd: '2026-02-28' },
    ]);
    expect(alerts.map((a) => a[2])).toEqual([UNKNOWN[2], 'Deadline: 2026-08-31']);
  });
});
