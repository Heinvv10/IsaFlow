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

import {
  createPayScale,
  listPayScales,
  updatePayScale,
  assignEmployeePayScale,
  PayScaleNotFoundError,
  InvalidSalaryBandError,
} from '@/modules/accounting/services/payroll/payScaleService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SCALE_ID = 'ss000001-0000-0000-0000-000000000001';
const EMP_ID = 'e0000001-0000-0000-0000-000000000001';
const USER_ID = 'user-1';

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('createPayScale', () => {
  it('inserts a scale scoped to company', async () => {
    const row = {
      id: SCALE_ID, company_id: COMPANY_ID, code: 'G5', name: 'Grade 5',
      grade_level: 5, min_salary: '30000', mid_salary: '40000', max_salary: '50000',
      currency: 'ZAR', is_active: true, notes: null,
      created_by: USER_ID, created_at: new Date(), updated_at: new Date(),
    };
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('INSERT INTO pay_scales')) return Promise.resolve([row]);
      return Promise.resolve([]);
    };
    const result = await createPayScale({
      companyId: COMPANY_ID, code: 'G5', name: 'Grade 5',
      gradeLevel: 5, minSalary: 30000, midSalary: 40000, maxSalary: 50000,
      userId: USER_ID,
    });
    expect(result.code).toBe('G5');
    expect(result.minSalary).toBe(30000);
  });

  it('rejects min > mid', async () => {
    await expect(createPayScale({
      companyId: COMPANY_ID, code: 'BAD', name: 'Bad',
      gradeLevel: 1, minSalary: 50000, midSalary: 40000, maxSalary: 60000,
      userId: USER_ID,
    })).rejects.toBeInstanceOf(InvalidSalaryBandError);
  });

  it('rejects mid > max', async () => {
    await expect(createPayScale({
      companyId: COMPANY_ID, code: 'BAD', name: 'Bad',
      gradeLevel: 1, minSalary: 30000, midSalary: 50000, maxSalary: 40000,
      userId: USER_ID,
    })).rejects.toBeInstanceOf(InvalidSalaryBandError);
  });
});

describe('listPayScales', () => {
  it('scopes by company and orders by grade_level', async () => {
    mockImpl = () => Promise.resolve([]);
    await listPayScales(COMPANY_ID);
    const call = sqlCalls.find(c => c.sql.includes('FROM pay_scales'));
    expect(call!.values).toContain(COMPANY_ID);
    expect(call!.sql).toMatch(/ORDER BY.*grade_level/);
  });
});

describe('updatePayScale', () => {
  it('rejects band violation when min,mid,max all provided', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM pay_scales')) return Promise.resolve([{ id: SCALE_ID, min_salary: '30000', mid_salary: '40000', max_salary: '50000' }]);
      return Promise.resolve([]);
    };
    await expect(updatePayScale(COMPANY_ID, SCALE_ID, { minSalary: 60000 }))
      .rejects.toBeInstanceOf(InvalidSalaryBandError);
  });

  it('throws when scale in another company', async () => {
    mockImpl = () => Promise.resolve([]);
    await expect(updatePayScale(COMPANY_ID, SCALE_ID, { name: 'x' }))
      .rejects.toBeInstanceOf(PayScaleNotFoundError);
  });
});

describe('assignEmployeePayScale', () => {
  it('updates FK and writes history when userId given', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID, pay_scale_id: null }]);
      if (q.includes('FROM pay_scales')) return Promise.resolve([{ id: SCALE_ID }]);
      return Promise.resolve([]);
    };
    await assignEmployeePayScale(COMPANY_ID, EMP_ID, SCALE_ID, USER_ID);
    expect(sqlCalls.some(c => c.sql.includes('UPDATE payroll_employees'))).toBe(true);
    expect(sqlCalls.some(c => c.sql.includes('INSERT INTO payroll_employee_history'))).toBe(true);
  });

  it('clears assignment when payScaleId is null', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID, pay_scale_id: SCALE_ID }]);
      return Promise.resolve([]);
    };
    await assignEmployeePayScale(COMPANY_ID, EMP_ID, null);
    const update = sqlCalls.find(c => c.sql.includes('UPDATE payroll_employees'));
    expect(update!.values).toContain(null);
  });
});
