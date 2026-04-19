/**
 * Unit tests for emp201Service.ts — Phase 1 schema (payroll_run_headers)
 *
 * Tests verify:
 * 1. Happy path: reads from payroll_run_headers (not legacy payroll_runs/payslips)
 *    and returns populated EMP201Data with correct aggregations.
 * 2. Company-id scoping: the SQL query must include company_id and the UUID binding.
 * 3. Tables-missing path: returns zero-filled EMP201Data without throwing.
 * 4. UIF 50/50 split: totalUIF_employee + totalUIF_employer === totalUIF.
 * 5. payrollRuns shape: runDate constructed from period_year + period_month.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const PERIOD_START = '2025-03-01';
const PERIOD_END = '2025-03-31';

const TABLE_CHECK_ROWS = [
  { table_name: 'payroll_run_headers' },
  { table_name: 'payroll_run_lines' },
];

const HEADER_ROW = {
  id: 'run-1',
  period_month: 3,
  period_year: 2025,
  employee_count: 2,
  total_gross: 50000,
  total_paye: 7000,
  total_uif: 1000,
  total_sdl: 500,
};

/**
 * Set up mocks for the two SQL calls the service makes:
 *  1. information_schema.tables check
 *  2. payroll_run_headers main query
 */
function mockHappyPath(headerRows: unknown[] = [HEADER_ROW]) {
  vi.mocked(sql)
    .mockResolvedValueOnce(TABLE_CHECK_ROWS as never)
    .mockResolvedValueOnce(headerRows as never);
}

function mockTablesAbsent() {
  // information_schema returns empty — tables not present
  vi.mocked(sql).mockResolvedValueOnce([] as never);
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe('emp201Service — Phase 1 schema (payroll_run_headers)', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Test 1: Happy path — reads from payroll_run_headers ─────────────────────

  it('reads from payroll_run_headers (not legacy payroll_runs/payslips)', async () => {
    mockHappyPath();

    const res = await generateEMP201(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(res.totalPAYE).toBe(7000);
    expect(res.totalUIF).toBe(1000);
    expect(res.totalSDL).toBe(500);
    expect(res.totalTaxableRemuneration).toBe(50000);
    expect(res.employeeCount).toBe(2);
    expect(res.payrollRuns).toHaveLength(1);

    // Verify correct table used — check the SQL calls via captured template strings
    const calls = vi.mocked(sql).mock.calls;
    const allSql = calls.map((call) => (call[0] as TemplateStringsArray).join('?')).join('\n');

    expect(allSql).toContain('payroll_run_headers');
    expect(allSql).not.toContain('FROM payroll_runs ');
    expect(allSql).not.toContain('FROM payslips');
  });

  // ── Test 2: Company-id scoping ───────────────────────────────────────────────

  it('includes company_id scope on the main payroll_run_headers query', async () => {
    mockHappyPath();

    await generateEMP201(COMPANY_ID, PERIOD_START, PERIOD_END);

    const calls = vi.mocked(sql).mock.calls;
    // Find the payroll_run_headers query (not the information_schema check)
    const mainCall = calls.find((call) => {
      const fragment = (call[0] as TemplateStringsArray).join('?');
      return fragment.includes('FROM payroll_run_headers');
    });

    expect(mainCall).toBeDefined();
    const sqlFragment = (mainCall![0] as TemplateStringsArray).join('?');
    expect(sqlFragment).toContain('company_id');

    // The company UUID must appear as a binding value
    const values = mainCall!.slice(1);
    expect(values).toContain(COMPANY_ID);
  });

  // ── Test 3: Tables absent — returns zero-filled data ────────────────────────

  it('returns zero-filled data when payroll tables are absent', async () => {
    mockTablesAbsent();

    const res = await generateEMP201(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(res.totalPAYE).toBe(0);
    expect(res.totalUIF).toBe(0);
    expect(res.totalUIF_employee).toBe(0);
    expect(res.totalUIF_employer).toBe(0);
    expect(res.totalSDL).toBe(0);
    expect(res.employeeCount).toBe(0);
    expect(res.totalTaxableRemuneration).toBe(0);
    expect(res.totalDeductions).toBe(0);
    expect(res.payrollRuns).toEqual([]);
    // periodStart/periodEnd must still be echoed back
    expect(res.periodStart).toBe(PERIOD_START);
    expect(res.periodEnd).toBe(PERIOD_END);
  });

  // ── Test 4: UIF 50/50 split ──────────────────────────────────────────────────

  it('splits total_uif 50/50 into employee and employer portions', async () => {
    mockHappyPath();

    const res = await generateEMP201(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(res.totalUIF_employee).toBe(500);
    expect(res.totalUIF_employer).toBe(500);
    expect(res.totalUIF_employee + res.totalUIF_employer).toBe(res.totalUIF);
  });

  // ── Test 5: payrollRuns shape and runDate construction ───────────────────────

  it('constructs runDate from period_year + period_month (ISO first-of-month)', async () => {
    mockHappyPath();

    const res = await generateEMP201(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(res.payrollRuns[0].runDate).toBe('2025-03-01');
    expect(res.payrollRuns[0].id).toBe('run-1');
    expect(res.payrollRuns[0].employeeCount).toBe(2);
    expect(res.payrollRuns[0].grossPay).toBe(50000);
    expect(res.payrollRuns[0].paye).toBe(7000);
    expect(res.payrollRuns[0].uif).toBe(1000);
    expect(res.payrollRuns[0].sdl).toBe(500);
  });

  // ── Test 6: totalDeductions aggregation ─────────────────────────────────────

  it('computes totalDeductions as PAYE + UIF + SDL', async () => {
    mockHappyPath();

    const res = await generateEMP201(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(res.totalDeductions).toBe(7000 + 1000 + 500); // 8500
  });

  // ── Test 7: Multiple runs across the period ──────────────────────────────────

  it('aggregates totals across multiple payroll runs in the period', async () => {
    const run2 = {
      id: 'run-2',
      period_month: 4,
      period_year: 2025,
      employee_count: 3,
      total_gross: 60000,
      total_paye: 8000,
      total_uif: 1200,
      total_sdl: 600,
    };

    vi.mocked(sql)
      .mockResolvedValueOnce(TABLE_CHECK_ROWS as never)
      .mockResolvedValueOnce([HEADER_ROW, run2] as never);

    const res = await generateEMP201(COMPANY_ID, '2025-03-01', '2025-04-30');

    expect(res.totalPAYE).toBe(7000 + 8000);    // 15000
    expect(res.totalUIF).toBe(1000 + 1200);      // 2200
    expect(res.totalSDL).toBe(500 + 600);        // 1100
    expect(res.totalTaxableRemuneration).toBe(50000 + 60000); // 110000
    expect(res.employeeCount).toBe(3);           // max across runs
    expect(res.payrollRuns).toHaveLength(2);
  });
});
