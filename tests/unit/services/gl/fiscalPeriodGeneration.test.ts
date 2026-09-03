/**
 * `createFiscalYear` must generate periods against the COMPANY'S financial year,
 * not against the calendar.
 *
 * The state this fixes: every production company carries
 * `financial_year_start = 3` and every one of the 288 fiscal periods in the
 * database runs January–December. Brightsphere's "fiscal year 2026" is
 * 1 Jan – 31 Dec 2026 and its AFS is signed for 1 Mar 2025 – 28 Feb 2026. The
 * two share ten months and nothing reconciles across the other four.
 *
 * The second half is the refusal. Existing tenants already hold calendar-aligned
 * periods, and a fiscal-aligned year overlaps them — the `fiscal_periods_no_overlap`
 * EXCLUDE constraint raises 23P01, which surfaces as a generic 500 that tells
 * nobody what happened. Re-dating live periods is explicitly out of scope for
 * this programme, so the service refuses with a message naming the conflict and
 * leaves the decision to a human.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(),
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txSpy)),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import {
  createFiscalYear,
  FiscalPeriodOverlapError,
} from '@/modules/accounting/services/gl/fiscalPeriodService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

/** Captures every INSERT the transaction issues, with its interpolated values. */
const inserted: Array<{ text: string; values: unknown[] }> = [];
const txSpy = ((strings: TemplateStringsArray, ...values: unknown[]) => {
  inserted.push({ text: strings.join('?'), values });
  return Promise.resolve([{
    id: `p${inserted.length}`,
    period_name: String(values[1]),
    period_number: Number(values[2]),
    fiscal_year: Number(values[3]),
    start_date: String(values[4]),
    end_date: String(values[5]),
    status: 'open',
    created_at: 'now',
    updated_at: 'now',
  }]);
}) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function sqlText(callIndex: number): string {
  const first = mockSql.mock.calls[callIndex]?.[0] as TemplateStringsArray | undefined;
  return (first ?? ([] as unknown as TemplateStringsArray)).join(' ? ');
}

beforeEach(() => {
  vi.clearAllMocks();
  // mockReset, not just clearAllMocks: the latter leaves the
  // mockResolvedValueOnce QUEUE intact, so a test that refuses early leaks its
  // unconsumed values into the next one.
  mockSql.mockReset();
  inserted.length = 0;
});

/** existing-year check → alignment read → overlap check. */
function mockPreChecks(
  startMonth: number | null,
  overlapping: unknown[] = [],
  existingStartMonth: number | null = null,
): void {
  mockSql
    .mockResolvedValueOnce([{ cnt: '0' }])
    .mockResolvedValueOnce([
      { financial_year_start: startMonth, existing_start_month: existingStartMonth },
    ])
    .mockResolvedValueOnce(overlapping);
}

describe('createFiscalYear — fiscal alignment', () => {
  it('reads the company financial_year_start and builds March–February periods', async () => {
    mockPreChecks(3);

    const periods = await createFiscalYear(COMPANY, 2027);

    expect(sqlText(1)).toMatch(/financial_year_start/);
    expect(mockSql.mock.calls[1]?.[1]).toBe(COMPANY);

    expect(periods).toHaveLength(12);
    expect(periods[0]).toMatchObject({
      periodNumber: 1, periodName: 'March 2026',
      startDate: '2026-03-01', endDate: '2026-03-31',
    });
    expect(periods[11]).toMatchObject({
      periodNumber: 12, periodName: 'February 2027',
      startDate: '2027-02-01', endDate: '2027-02-28',
    });
  });

  it('still builds January–December for a company whose year starts in January', async () => {
    mockPreChecks(1);

    const periods = await createFiscalYear(COMPANY, 2026);

    expect(periods[0]).toMatchObject({ startDate: '2026-01-01', periodName: 'January 2026' });
    expect(periods[11]).toMatchObject({ endDate: '2026-12-31' });
  });

  it('REFUSES when financial_year_start is unusable rather than assuming March', async () => {
    // The shared basis (gl/fiscalYearBasis) is called with NO fallback here.
    // createFiscalYear is a write path: building a year on a guessed March
    // start is silent, and once journals post into those periods it is not
    // recoverable. Zero production companies have a NULL today, so this is a
    // guard against future misconfiguration, not a behaviour change on live
    // data. Read paths that must survive a misconfigured tenant opt in to a
    // fallback at the call site, where the assumption is visible.
    mockPreChecks(null);

    await expect(createFiscalYear(COMPANY, 2027))
      .rejects.toThrow(/no usable financial_year_start/);
    expect(inserted).toHaveLength(0);
  });

  it('still refuses when the existing layout is usable but the declared value is not', async () => {
    // The observed layout would have been enough to BUILD the year, but the
    // declared month is what `alignment` reports against — reporting "aligned"
    // against a guessed March is the silent assumption this refuses to make.
    mockPreChecks(null, [], 1);
    await expect(createFiscalYear(COMPANY, 2027)).rejects.toThrow(/financial_year_start/);
  });

  it('FOLLOWS the layout the company already has, even when it contradicts the declared year', async () => {
    // Brightsphere: financial_year_start = 3, but every existing period runs
    // Jan–Dec. Building the next year on March would interleave two layouts in
    // one company, which is worse than being consistently wrong. The
    // misalignment is REPORTED (list_fiscal_periods.alignment), not half-fixed.
    mockPreChecks(3, [], 1);

    const periods = await createFiscalYear(COMPANY, 2028);

    expect(periods[0]).toMatchObject({ startDate: '2028-01-01', periodName: 'January 2028' });
    expect(periods[11]!.endDate).toBe('2028-12-31');
  });

  it('binds every pre-check query to this tenant', async () => {
    mockPreChecks(3);
    await createFiscalYear(COMPANY, 2027);
    // The company row is keyed by `id`; everything else by `company_id`. Either
    // way the FIRST interpolated value is the tenant, on all three.
    expect(sqlText(0)).toMatch(/company_id/);
    expect(sqlText(1)).toMatch(/FROM companies c\s+WHERE c\.id/);
    expect(sqlText(2)).toMatch(/company_id/);
    for (let i = 0; i < 3; i++) expect(mockSql.mock.calls[i]?.[1]).toBe(COMPANY);
  });

  it('stamps company_id on every inserted period', async () => {
    mockPreChecks(3);
    await createFiscalYear(COMPANY, 2027);
    expect(inserted).toHaveLength(12);
    for (const row of inserted) expect(row.values[0]).toBe(COMPANY);
  });

  it('REFUSES when the new range overlaps periods that already exist', async () => {
    mockPreChecks(3, [
      { id: 'x', period_name: 'March 2026', fiscal_year: 2026, start_date: '2026-03-01', end_date: '2026-03-31' },
      { id: 'y', period_name: 'April 2026', fiscal_year: 2026, start_date: '2026-04-01', end_date: '2026-04-30' },
    ]);

    await expect(createFiscalYear(COMPANY, 2027)).rejects.toThrow(FiscalPeriodOverlapError);
    expect(inserted).toHaveLength(0);
  });

  it('names the conflicting periods in the refusal so a human can act on it', async () => {
    mockPreChecks(3, [
      { id: 'x', period_name: 'March 2026', fiscal_year: 2026, start_date: '2026-03-01', end_date: '2026-03-31' },
    ]);

    await expect(createFiscalYear(COMPANY, 2027)).rejects.toThrow(/March 2026/);
  });

  it('checks for overlap against the whole fiscal range, not just the label year', async () => {
    mockPreChecks(3);
    await createFiscalYear(COMPANY, 2027);
    // The overlap probe is call 2 and must carry the derived boundary dates,
    // NOT the calendar year — that is the check that catches the collision.
    expect(mockSql.mock.calls[2]?.slice(1)).toEqual([COMPANY, '2027-02-28', '2026-03-01']);
  });

  it('still refuses a duplicate fiscal_year before doing anything else', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: '12' }]);
    await expect(createFiscalYear(COMPANY, 2027)).rejects.toThrow(/already exists/);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});
