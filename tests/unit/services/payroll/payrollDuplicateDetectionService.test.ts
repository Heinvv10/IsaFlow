import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => {
  const fakeStrings = (text: string): TemplateStringsArray =>
    Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray;
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  };
  (sqlFn as unknown as { unsafe: (text: string, values?: unknown[]) => unknown }).unsafe = (
    text: string,
    values: unknown[] = [],
  ) => {
    sqlCalls.push({ sql: text, values });
    return mockImpl(fakeStrings(text), ...values);
  };
  return { sql: sqlFn };
});

import { findDuplicates } from '@/modules/accounting/services/payroll/payrollDuplicateDetectionService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

function routeMatch(q: string, field: string): boolean {
  if (field === 'id_number') return q.includes('id_number') && !q.includes('tax_number') && !q.includes('passport');
  if (field === 'tax_number') return q.includes('tax_number');
  if (field === 'passport_number') return q.includes('passport_number');
  if (field === 'employee_number') return q.includes('employee_number') && q.includes('FROM payroll_employees') && !q.includes('payroll_bank_details');
  if (field === 'bank_account') return q.includes('payroll_bank_details');
  return false;
}

describe('findDuplicates', () => {
  it('returns a conflict group with 2+ employees sharing the same ID number', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (routeMatch(q, 'id_number')) {
        return Promise.resolve([
          {
            value: '8001015009087',
            employees: [
              { id: 'e1', employee_number: 'E001', name: 'Alice A', status: 'active' },
              { id: 'e2', employee_number: 'E002', name: 'Alice Twin', status: 'active' },
            ],
          },
        ]);
      }
      return Promise.resolve([]);
    };

    const result = await findDuplicates(COMPANY_ID, { includeTerminated: false });

    expect(result.idNumber).toHaveLength(1);
    expect(result.idNumber[0]?.value).toBe('8001015009087');
    expect(result.idNumber[0]?.employees).toHaveLength(2);
    expect(result.taxNumber).toEqual([]);
    expect(result.passportNumber).toEqual([]);
    expect(result.bankAccount).toEqual([]);
    expect(result.employeeNumber).toEqual([]);
  });

  it('never flags NULL or empty-string values', async () => {
    let called = false;
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('id_number')) {
        called = true;
        expect(q).toMatch(/IS NOT NULL/);
        expect(q).toMatch(/<>\s*''/);
      }
      return Promise.resolve([]);
    };

    await findDuplicates(COMPANY_ID);
    expect(called).toBe(true);
  });

  it('scopes every query by company_id', async () => {
    await findDuplicates(COMPANY_ID);
    for (const call of sqlCalls) {
      expect(call.values).toContain(COMPANY_ID);
    }
  });

  it('excludes terminated employees by default', async () => {
    let sawStatusFilter = false;
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('id_number')) {
        if (q.includes("status <> 'terminated'") || q.includes('status != ')) {
          sawStatusFilter = true;
        }
      }
      return Promise.resolve([]);
    };

    await findDuplicates(COMPANY_ID);
    expect(sawStatusFilter).toBe(true);
  });

  it('includes terminated employees when includeTerminated=true', async () => {
    let sawStatusFilter = false;
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('id_number') && (q.includes("status <> 'terminated'") || q.includes('status != '))) {
        sawStatusFilter = true;
      }
      return Promise.resolve([]);
    };

    await findDuplicates(COMPANY_ID, { includeTerminated: true });
    expect(sawStatusFilter).toBe(false);
  });

  it('detects duplicate bank account numbers across employees', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (routeMatch(q, 'bank_account')) {
        return Promise.resolve([
          {
            value: '1234567890',
            employees: [
              { id: 'e1', employee_number: 'E001', name: 'Alice A', status: 'active' },
              { id: 'e3', employee_number: 'E003', name: 'Charlie C', status: 'active' },
            ],
          },
        ]);
      }
      return Promise.resolve([]);
    };

    const result = await findDuplicates(COMPANY_ID);
    expect(result.bankAccount).toHaveLength(1);
    expect(result.bankAccount[0]?.employees).toHaveLength(2);
  });

  it('returns a summary totals.totalConflicts', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (routeMatch(q, 'id_number')) {
        return Promise.resolve([
          { value: 'x', employees: [{ id: 'a' }, { id: 'b' }] },
        ]);
      }
      if (routeMatch(q, 'tax_number')) {
        return Promise.resolve([
          { value: 'y', employees: [{ id: 'c' }, { id: 'd' }] },
        ]);
      }
      return Promise.resolve([]);
    };

    const result = await findDuplicates(COMPANY_ID);
    expect(result.totals.totalConflicts).toBe(2);
  });
});
