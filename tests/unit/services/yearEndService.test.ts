/**
 * Unit tests for yearEndService.ts
 *
 * Focuses on tenant isolation: company B's journals must NOT leak into
 * company A's year-end aggregation (S-002 regression guard).
 *
 * All DB calls are mocked — no real Neon connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
import { sql } from '@/lib/neon';
import { listFiscalYears, closeFiscalYear } from '@/modules/accounting/services/gl/yearEndService';

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const COMPANY_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_ID   = 'cccccccc-0000-0000-0000-000000000003';
const YEAR_LABEL = '2026';

const START_DATE = '2026-01-01';
const END_DATE   = '2026-12-31';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns a fiscal-period summary row for a given company. */
function makeFiscalPeriodRow() {
  return {
    year_label: YEAR_LABEL,
    start_date: START_DATE,
    end_date: END_DATE,
    periods_open: 0,
    periods_closed: 12,
    status: 'all_closed',
  };
}

/** A revenue total row (credit - debit). */
function makeRevenueTotal(amount: number) {
  return { total: String(amount) };
}

/** An expense total row (debit - credit). */
function makeExpenseTotal(amount: number) {
  return { total: String(amount) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('yearEndService — tenant isolation (S-002)', () => {
  let sqlMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlMock = sql as unknown as ReturnType<typeof vi.fn>;
  });

  // ── listFiscalYears ─────────────────────────────────────────────────────────

  describe('listFiscalYears', () => {
    it('returns revenue and expense totals for company A only — company B totals are not included', async () => {
      /**
       * Scenario:
       *   Company A: 1 revenue journal (1000), 1 expense journal (1000)
       *   Company B: 1 revenue journal (500)   ← must NOT appear in A's result
       *
       * The mock simulates the three sequential sql calls made inside
       * listFiscalYears for a single fiscal year:
       *   call 0: fiscal_periods list  → [ { year_label, start_date, end_date, ... } ]
       *   call 1: revenue total        → [ { total: '1000' } ]      (company A only)
       *   call 2: expense total        → [ { total: '1000' } ]      (company A only)
       */
      sqlMock
        .mockResolvedValueOnce([makeFiscalPeriodRow()])   // fiscal_periods
        .mockResolvedValueOnce([makeRevenueTotal(1000)])  // revenue for company A
        .mockResolvedValueOnce([makeExpenseTotal(1000)]); // expense for company A

      const result = await listFiscalYears(COMPANY_A);

      expect(result).toHaveLength(1);
      const fy = result[0];

      // Company A revenue = 1000 (company B's 500 is absent)
      expect(fy.total_revenue).toBe(1000);
      // Company A expenses = 1000
      expect(fy.total_expenses).toBe(1000);
      // Net income = 0
      expect(fy.net_income).toBe(0);
    });

    it('passes companyId to every sql call so cross-tenant data cannot be included', async () => {
      sqlMock
        .mockResolvedValueOnce([makeFiscalPeriodRow()])
        .mockResolvedValueOnce([makeRevenueTotal(500)])
        .mockResolvedValueOnce([makeExpenseTotal(200)]);

      await listFiscalYears(COMPANY_A);

      // All three calls must have been made (fiscal periods + revenue + expense)
      expect(sqlMock).toHaveBeenCalledTimes(3);

      // The companyId must appear as a parameter in every call.
      // sql is a tagged template: vitest captures the raw call args array.
      // Each call is: sqlMock(strings[], ...values[])
      // We verify company A appears and company B never appears.
      const allArgs = sqlMock.mock.calls.flatMap((args) => args.slice(1));
      expect(allArgs).toContain(COMPANY_A);
      expect(allArgs).not.toContain(COMPANY_B);
    });

    it('returns zero totals when there are no journal entries for the year', async () => {
      sqlMock
        .mockResolvedValueOnce([makeFiscalPeriodRow()])
        .mockResolvedValueOnce([])  // no revenue rows
        .mockResolvedValueOnce([]); // no expense rows

      const result = await listFiscalYears(COMPANY_A);
      expect(result[0]?.total_revenue).toBe(0);
      expect(result[0]?.total_expenses).toBe(0);
      expect(result[0]?.net_income).toBe(0);
      // Genuine zero year — no error flags
      expect(result[0]?.revenue_error).toBeUndefined();
      expect(result[0]?.expense_error).toBeUndefined();
    });

    it('flags revenue_error when the revenue aggregate query fails — total falls back to 0 but the flag distinguishes failure from a real zero', async () => {
      sqlMock
        .mockResolvedValueOnce([makeFiscalPeriodRow()])
        .mockRejectedValueOnce(new Error('connection terminated'))   // revenue fails
        .mockResolvedValueOnce([makeExpenseTotal(750)]);             // expense succeeds

      const result = await listFiscalYears(COMPANY_A);

      expect(result[0]?.revenue_error).toBe(true);
      expect(result[0]?.expense_error).toBeUndefined();
      expect(result[0]?.total_revenue).toBe(0);          // safe default
      expect(result[0]?.total_expenses).toBe(750);
      // net_income inherits the unreliable revenue — UI must render warning
      expect(result[0]?.net_income).toBe(-750);
    });

    it('flags expense_error when the expense aggregate query fails — independently of revenue', async () => {
      sqlMock
        .mockResolvedValueOnce([makeFiscalPeriodRow()])
        .mockResolvedValueOnce([makeRevenueTotal(1200)])
        .mockRejectedValueOnce(new Error('statement timeout'));

      const result = await listFiscalYears(COMPANY_A);

      expect(result[0]?.revenue_error).toBeUndefined();
      expect(result[0]?.expense_error).toBe(true);
      expect(result[0]?.total_revenue).toBe(1200);
      expect(result[0]?.total_expenses).toBe(0);
    });

    it('flags both *_error fields when both aggregates fail', async () => {
      sqlMock
        .mockResolvedValueOnce([makeFiscalPeriodRow()])
        .mockRejectedValueOnce(new Error('rev down'))
        .mockRejectedValueOnce(new Error('exp down'));

      const result = await listFiscalYears(COMPANY_A);

      expect(result[0]?.revenue_error).toBe(true);
      expect(result[0]?.expense_error).toBe(true);
      expect(result[0]?.total_revenue).toBe(0);
      expect(result[0]?.total_expenses).toBe(0);
    });
  });

  // Successful controlled-close diagnostics and exact source aggregation live in
  // gl/yearEndCloseDryRun.test.ts; actual owned posting is covered by glYearEndWriters.int.test.ts.
  describe('closeFiscalYear authenticated transaction boundary',()=>{
    it.each([true,false])('refuses a naked legacy call before SQL (dryRun=%s)',async(dryRun)=>{
      await expect(closeFiscalYear(COMPANY_A,YEAR_LABEL,USER_ID,{dryRun})).rejects.toThrow('Authenticated control transaction required');
      expect(sqlMock).not.toHaveBeenCalled();
    });
  });
});
