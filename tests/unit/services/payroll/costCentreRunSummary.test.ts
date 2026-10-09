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

import { costCentreSummaryForRun } from '@/modules/accounting/services/payroll/costCentreRunSummary';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_COMPANY = '11111111-1111-1111-1111-111111111111';
const CC_ID = 'cc000001-0000-0000-0000-000000000001';
const RUN_ID = 'r0000001-0000-0000-0000-000000000001';

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('costCentreSummaryForRun', () => {
  it('groups run lines by cost centre, including an "Unassigned" bucket', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_run_lines') && q.includes('cost_centre_id')) {
        return Promise.resolve([
          {
            cost_centre_id: CC_ID,
            cost_centre_code: 'ADMIN',
            cost_centre_name: 'Admin',
            employee_count: 3,
            total_gross: '60000',
            total_paye: '8000',
            total_uif: '720',
            total_sdl: '600',
            total_eti: '0',
            total_net: '50680',
          },
          {
            cost_centre_id: null,
            cost_centre_code: null,
            cost_centre_name: null,
            employee_count: 1,
            total_gross: '15000',
            total_paye: '2000',
            total_uif: '148.72',
            total_sdl: '150',
            total_eti: '0',
            total_net: '12701.28',
          },
        ]);
      }
      if (q.includes('FROM payroll_run_headers')) {
        return Promise.resolve([{ id: RUN_ID, company_id: COMPANY_ID }]);
      }
      return Promise.resolve([]);
    };

    const summary = await costCentreSummaryForRun(COMPANY_ID, RUN_ID);
    expect(summary.rows).toHaveLength(2);
    expect(summary.rows[0]!.costCentreCode).toBe('ADMIN');
    expect(summary.rows[0]!.totalGross).toBe(60000);
    expect(summary.rows[1]!.costCentreCode).toBeNull();
    expect(summary.totals.totalGross).toBeCloseTo(75000, 2);
    expect(summary.totals.employeeCount).toBe(4);
  });

  it('rejects run belonging to another company', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_run_headers')) return Promise.resolve([]);
      return Promise.resolve([]);
    };
    await expect(costCentreSummaryForRun(OTHER_COMPANY, RUN_ID)).rejects.toThrow(/not found/i);
  });
});
