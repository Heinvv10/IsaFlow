import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  },
}));

import { getParallelRunReport } from '@/modules/accounting/services/payroll/payrollParallelRunReportService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const IMPORT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const RUN_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const IMPORT_ROW = {
  id: IMPORT_ID, company_id: COMPANY_ID, period_month: 8, period_year: 2026,
  source: 'VIP', file_name: 'aug.csv', payslip_count: 1,
  components_present: ['gross', 'paye', 'net'], created_at: '2026-08-31T10:00:00Z',
};
const RUN_ROW = { id: RUN_ID, period_month: 8, period_year: 2026, status: 'approved' };

function routeMock(routes: Array<{ match: string; rows: unknown[] }>) {
  mockImpl = (strings) => {
    const q = strings.join('?');
    const hit = routes.find((r) => q.includes(r.match));
    return Promise.resolve(hit ? hit.rows : []);
  };
}

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('getParallelRunReport', () => {
  it('returns null when the import does not exist for this company', async () => {
    expect(await getParallelRunReport(COMPANY_ID, IMPORT_ID)).toBeNull();
  });

  it('returns run/comparison null when no run exists for the period', async () => {
    routeMock([{ match: 'FROM payroll_external_imports', rows: [IMPORT_ROW] }]);
    const report = await getParallelRunReport(COMPANY_ID, IMPORT_ID);
    expect(report).not.toBeNull();
    expect(report!.run).toBeNull();
    expect(report!.comparison).toBeNull();
  });

  it('throws when an explicit runId is not found (foreign or bogus)', async () => {
    routeMock([{ match: 'FROM payroll_external_imports', rows: [IMPORT_ROW] }]);
    await expect(getParallelRunReport(COMPANY_ID, IMPORT_ID, RUN_ID)).rejects.toThrow(/run not found/i);
  });

  it('converts NUMERIC(14,2) rand strings to exact cents (float boundary) and compares', async () => {
    routeMock([
      { match: 'FROM payroll_external_imports', rows: [IMPORT_ROW] },
      { match: 'FROM payroll_run_headers', rows: [RUN_ROW] },
      {
        match: 'FROM payroll_run_lines',
        rows: [{
          // 4.15 * 100 = 414.999…, 0.29 * 100 = 28.999… — the classic float traps
          gross_pay: '4.15', paye: '0.29', uif_employee: '0.07', uif_employer: '0.07',
          sdl: '0.00', eti: '0.00', net_pay: '3.86',
          employee_number: 'E001', first_name: 'Thandi', last_name: 'Mokoena',
        }],
      },
      {
        match: 'FROM payroll_external_payslips',
        rows: [{
          employee_number: 'E001', employee_name: 'Thandi Mokoena',
          gross_cents: '415', paye_cents: '29', uif_employee_cents: null,
          uif_employer_cents: null, uif_total_cents: null, sdl_cents: null,
          eti_cents: null, net_cents: '386',
        }],
      },
    ]);

    const report = await getParallelRunReport(COMPANY_ID, IMPORT_ID);
    expect(report!.run!.id).toBe(RUN_ID);
    const comparison = report!.comparison!;
    expect(comparison.employees).toHaveLength(1);
    // exact integer-cent match — fails if randToCents truncates instead of rounding
    expect(comparison.employees[0]!.status).toBe('match');
    expect(comparison.summary.matchRate).toBe(1);

    const linesCall = sqlCalls.find((c) => c.sql.includes('FROM payroll_run_lines'))!;
    expect(linesCall.sql).toContain('company_id =');
    expect(linesCall.values).toContain(COMPANY_ID);
  });
});
