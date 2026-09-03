/**
 * emp201Service — V-09 (payroll run status vocabulary) and V-10 (ETI offset).
 *
 * V-09: the service filtered `status = 'calculated'`, but a payroll run's
 *       terminal states are 'approved' and 'paid' — 'calculated' is an interim
 *       state that has NOT posted its GL journal. Production held 85 approved
 *       runs and 1 calculated one, so EMP201 declared R0 PAYE for the demo
 *       company where the 2026 figure is R751,844.46.
 *
 * V-10: `payroll_run_headers.total_eti` was never read, so EMP201 overstated
 *       the PAYE actually payable to SARS. ETI is an offset against PAYE.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import {
  PAYROLL_RUN_STATUSES,
  EMP201_DECLARABLE_STATUSES,
} from '@/lib/constants/payrollRunStatuses';

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';

const TABLE_CHECK_ROWS = [
  { table_name: 'payroll_run_headers' },
  { table_name: 'payroll_run_lines' },
];

function headerRow(over: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    period_month: 3,
    period_year: 2026,
    employee_count: 4,
    total_gross: 313000,
    total_paye: 62653.71,
    total_uif: 2437.26,
    total_sdl: 2505,
    total_eti: 0,
    ...over,
  };
}

function mockRun(rows: unknown[]) {
  vi.mocked(sql)
    .mockResolvedValueOnce(TABLE_CHECK_ROWS as never)
    .mockResolvedValueOnce(rows as never);
}

/** The SQL text + bound values of the payroll_run_headers query. */
function mainQuery() {
  const call = vi.mocked(sql).mock.calls.find((c) =>
    (c[0] as TemplateStringsArray).join('?').includes('FROM payroll_run_headers'),
  );
  expect(call).toBeDefined();
  return {
    text: (call![0] as TemplateStringsArray).join('?'),
    values: call!.slice(1) as unknown[],
  };
}

describe('emp201Service — V-09 payroll run status vocabulary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('declares approved and paid runs, and only those', () => {
    // The constant is the contract: the full DB vocabulary is the five values
    // the payroll_run_headers_status_check constraint allows, and only the two
    // terminal ones are declarable on an EMP201.
    expect([...PAYROLL_RUN_STATUSES].sort()).toEqual(
      ['approved', 'calculated', 'cancelled', 'draft', 'paid'],
    );
    expect([...EMP201_DECLARABLE_STATUSES].sort()).toEqual(['approved', 'paid']);
  });

  it('binds the declarable statuses to the payroll_run_headers query', async () => {
    mockRun([headerRow()]);
    await generateEMP201(COMPANY_ID, '2026-03-01', '2026-03-31');

    const { text, values } = mainQuery();

    // The status predicate must be a bound parameter, not an inlined literal.
    expect(text).not.toContain("'calculated'");
    expect(text).not.toContain("'approved'");

    const statusArg = values.find((v) => Array.isArray(v)) as string[] | undefined;
    expect(statusArg).toBeDefined();
    expect([...statusArg!].sort()).toEqual(['approved', 'paid']);

    // Nothing that is not finalised may reach the declaration.
    expect(statusArg).not.toContain('draft');
    expect(statusArg).not.toContain('calculated');
    expect(statusArg).not.toContain('cancelled');
  });

  it('aggregates a full approved year — the demo company 2026 PAYE figure', async () => {
    // 12 approved runs summing to the production 2026 total.
    const rows = Array.from({ length: 12 }, (_, i) =>
      headerRow({ id: `run-${i + 1}`, period_month: i + 1, total_paye: 62653.705 }),
    );
    mockRun(rows);

    const res = await generateEMP201(COMPANY_ID, '2026-01-01', '2026-12-31');
    expect(res.totalPAYE).toBeCloseTo(751844.46, 2);
    expect(res.payrollRuns).toHaveLength(12);
  });
});

describe('emp201Service — V-10 ETI offset against PAYE', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads total_eti and reports PAYE payable net of it', async () => {
    mockRun([headerRow({ total_paye: 10000, total_eti: 1500 })]);

    const res = await generateEMP201(COMPANY_ID, '2026-03-01', '2026-03-31');

    expect(res.totalPAYE).toBe(10000);      // gross PAYE withheld — unchanged
    expect(res.totalETI).toBe(1500);
    expect(res.payePayable).toBe(8500);     // what is actually remitted
    expect(res.payrollRuns[0]!.eti).toBe(1500);
  });

  it('selects total_eti from the database', async () => {
    mockRun([headerRow()]);
    await generateEMP201(COMPANY_ID, '2026-03-01', '2026-03-31');
    expect(mainQuery().text).toContain('total_eti');
  });

  it('nets ETI out of the total payable to SARS', async () => {
    mockRun([headerRow({ total_paye: 10000, total_uif: 2000, total_sdl: 1000, total_eti: 1500 })]);

    const res = await generateEMP201(COMPANY_ID, '2026-03-01', '2026-03-31');

    // (10000 − 1500) + 2000 + 1000
    expect(res.totalDeductions).toBe(11500);
  });

  it('treats a NULL total_eti as zero without nulling the whole figure', async () => {
    mockRun([headerRow({ total_paye: 10000, total_eti: null })]);

    const res = await generateEMP201(COMPANY_ID, '2026-03-01', '2026-03-31');

    expect(res.totalETI).toBe(0);
    expect(res.payePayable).toBe(10000);
    expect(Number.isNaN(res.payePayable)).toBe(false);
    expect(res.payrollRuns[0]!.eti).toBe(0);
  });

  it('sums ETI across runs and never lets it turn PAYE payable negative by accident', async () => {
    mockRun([
      headerRow({ id: 'r1', total_paye: 5000, total_eti: 1200 }),
      headerRow({ id: 'r2', period_month: 4, total_paye: 6000, total_eti: 800 }),
    ]);

    const res = await generateEMP201(COMPANY_ID, '2026-03-01', '2026-04-30');

    expect(res.totalETI).toBe(2000);
    expect(res.totalPAYE).toBe(11000);
    expect(res.payePayable).toBe(9000);
  });

  it('zero-fills ETI fields when the payroll tables are absent', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    const res = await generateEMP201(COMPANY_ID, '2026-03-01', '2026-03-31');
    expect(res.totalETI).toBe(0);
    expect(res.payePayable).toBe(0);
  });
});
