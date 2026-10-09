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

vi.mock('@/modules/accounting/services/payroll/payrollEmployeeHistoryService', () => ({
  recordEmployeeChange: vi.fn().mockResolvedValue(undefined),
}));

import {
  listCostCentres,
  assignEmployeeCostCentre,
  costCentreSummaryForRun,
  CostCentreNotFoundError,
  getPayrollCostCentre,
} from '@/modules/accounting/services/core/costCentreService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_COMPANY = '11111111-1111-1111-1111-111111111111';
const CC_ID = 'cc000001-0000-0000-0000-000000000001';
const EMP_ID = 'e0000001-0000-0000-0000-000000000001';
const RUN_ID = 'r0000001-0000-0000-0000-000000000001';
const USER_ID = 'user-1';

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('listCostCentres', () => {
  it('scopes by company and optionally filters by active', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM cost_centres')) return Promise.resolve([{
        id: CC_ID, company_id: COMPANY_ID, code: 'A', name: 'A', parent_id: null,
        is_active: true, notes: null, created_by: USER_ID,
        created_at: new Date(), updated_at: new Date(),
      }]);
      return Promise.resolve([]);
    };

    const result = await listCostCentres(COMPANY_ID, { activeOnly: true });
    expect(result).toHaveLength(1);
    const call = sqlCalls.find(c => c.sql.includes('FROM cost_centres'));
    expect(call).toBeDefined();
    expect(call!.values).toContain(COMPANY_ID);
  });
});

describe('assignEmployeeCostCentre', () => {
  it('updates payroll_employees.cost_centre_id after verifying both belong to company', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID }]);
      if (q.includes('FROM cost_centres')) return Promise.resolve([{ id: CC_ID }]);
      if (q.includes('UPDATE payroll_employees')) return Promise.resolve([]);
      return Promise.resolve([]);
    };
    await assignEmployeeCostCentre(COMPANY_ID, EMP_ID, CC_ID);
    expect(sqlCalls.some(c => c.sql.includes('UPDATE payroll_employees'))).toBe(true);
  });

  it('clears assignment when costCentreId is null', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID }]);
      return Promise.resolve([]);
    };
    await assignEmployeeCostCentre(COMPANY_ID, EMP_ID, null);
    const update = sqlCalls.find(c => c.sql.includes('UPDATE payroll_employees'));
    expect(update).toBeDefined();
    expect(update!.values).toContain(null);
  });

  it('throws when cost centre not in company', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID }]);
      if (q.includes('FROM cost_centres')) return Promise.resolve([]);
      return Promise.resolve([]);
    };
    await expect(assignEmployeeCostCentre(COMPANY_ID, EMP_ID, CC_ID)).rejects.toBeInstanceOf(CostCentreNotFoundError);
  });
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

describe('getPayrollCostCentre', () => {
  it('reads one centre scoped to the company and maps it; null when not this company\'s', async () => {
    mockImpl = () => Promise.resolve([{ id: CC_ID, company_id: COMPANY_ID, code: 'ADMIN', name: 'Admin', parent_id: null,
      is_active: true, notes: null, created_by: USER_ID, created_at: '2026-05-13T00:00:00Z', updated_at: '2026-05-13T00:00:00Z' }]);
    const cc = await getPayrollCostCentre(COMPANY_ID, CC_ID);
    expect(sqlCalls[0]!.sql).toMatch(/WHERE id = \?::uuid AND company_id = \?::uuid/);
    expect(sqlCalls[0]!.values).toEqual([CC_ID, COMPANY_ID]);
    expect(cc).toMatchObject({ id: CC_ID, code: 'ADMIN', createdBy: USER_ID });
    mockImpl = () => Promise.resolve([]);
    expect(await getPayrollCostCentre(OTHER_COMPANY, CC_ID)).toBeNull();
  });
});
