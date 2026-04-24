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
  createPayPackage,
  listPayPackages,
  getPayPackage,
  setPackageComponents,
  applyPackageToEmployee,
  PayPackageNotFoundError,
} from '@/modules/accounting/services/payroll/payPackageService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PKG_ID = 'pp000001-0000-0000-0000-000000000001';
const COMP_A = 'c0000001-0000-0000-0000-00000000000a';
const COMP_B = 'c0000001-0000-0000-0000-00000000000b';
const EMP_ID = 'e0000001-0000-0000-0000-000000000001';
const USER_ID = 'user-1';

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('createPayPackage + setPackageComponents', () => {
  it('inserts the header then replaces the component rows in a transaction', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('INSERT INTO pay_packages')) return Promise.resolve([{
        id: PKG_ID, company_id: COMPANY_ID, code: 'EXEC', name: 'Executive',
        description: null, is_active: true,
        created_by: USER_ID, created_at: new Date(), updated_at: new Date(),
      }]);
      if (q.includes('FROM pay_packages')) return Promise.resolve([{ id: PKG_ID }]);
      if (q.includes('FROM payroll_components')) return Promise.resolve([{ id: COMP_A }, { id: COMP_B }]);
      return Promise.resolve([]);
    };
    const created = await createPayPackage({
      companyId: COMPANY_ID, code: 'EXEC', name: 'Executive', userId: USER_ID,
    });
    expect(created.id).toBe(PKG_ID);

    await setPackageComponents(COMPANY_ID, PKG_ID, [
      { componentId: COMP_A, amount: 10000, isRecurring: true },
      { componentId: COMP_B, amount: 5000, isRecurring: true },
    ]);
    expect(sqlCalls.some(c => c.sql.trim() === 'BEGIN')).toBe(true);
    expect(sqlCalls.some(c => c.sql.includes('DELETE FROM pay_package_components'))).toBe(true);
    expect(sqlCalls.filter(c => c.sql.includes('INSERT INTO pay_package_components')).length).toBe(2);
    expect(sqlCalls.some(c => c.sql.trim() === 'COMMIT')).toBe(true);
  });

  it('setPackageComponents rejects package not in company', async () => {
    mockImpl = () => Promise.resolve([]);
    await expect(setPackageComponents(COMPANY_ID, PKG_ID, []))
      .rejects.toBeInstanceOf(PayPackageNotFoundError);
  });
});

describe('getPayPackage', () => {
  it('returns header + sorted component rows', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM pay_packages') && !q.includes('component')) {
        return Promise.resolve([{
          id: PKG_ID, company_id: COMPANY_ID, code: 'EXEC', name: 'Executive',
          description: null, is_active: true,
          created_by: USER_ID, created_at: new Date(), updated_at: new Date(),
        }]);
      }
      if (q.includes('FROM pay_package_components')) {
        return Promise.resolve([
          { id: 'pc1', component_id: COMP_A, component_name: 'Basic', sars_source_code: '3601',
            component_type: 'earning', amount: '50000', is_recurring: true },
          { id: 'pc2', component_id: COMP_B, component_name: 'Travel', sars_source_code: '3701',
            component_type: 'earning', amount: '5000', is_recurring: true },
        ]);
      }
      return Promise.resolve([]);
    };
    const pkg = await getPayPackage(COMPANY_ID, PKG_ID);
    expect(pkg).not.toBeNull();
    expect(pkg!.components).toHaveLength(2);
    expect(pkg!.components[0]!.componentName).toBe('Basic');
    expect(pkg!.components[0]!.amount).toBe(50000);
  });
});

describe('applyPackageToEmployee', () => {
  it('end-dates overlapping assignments and inserts one new row per package component', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID }]);
      if (q.includes('FROM pay_packages')) return Promise.resolve([{ id: PKG_ID }]);
      if (q.includes('FROM pay_package_components')) {
        return Promise.resolve([
          { component_id: COMP_A, amount: '10000', is_recurring: true },
          { component_id: COMP_B, amount: '5000', is_recurring: true },
        ]);
      }
      return Promise.resolve([]);
    };
    const out = await applyPackageToEmployee(COMPANY_ID, PKG_ID, EMP_ID, '2026-05-01', USER_ID);
    expect(out.inserted).toBe(2);
    expect(sqlCalls.some(c => c.sql.trim() === 'BEGIN')).toBe(true);
    expect(sqlCalls.filter(c => c.sql.includes('UPDATE payroll_employee_components')).length).toBe(2);
    expect(sqlCalls.filter(c => c.sql.includes('INSERT INTO payroll_employee_components')).length).toBe(2);
    expect(sqlCalls.some(c => c.sql.trim() === 'COMMIT')).toBe(true);
  });

  it('rolls back on failure', async () => {
    let insertCount = 0;
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID }]);
      if (q.includes('FROM pay_packages')) return Promise.resolve([{ id: PKG_ID }]);
      if (q.includes('FROM pay_package_components')) {
        return Promise.resolve([
          { component_id: COMP_A, amount: '10000', is_recurring: true },
          { component_id: COMP_B, amount: '5000', is_recurring: true },
        ]);
      }
      if (q.includes('INSERT INTO payroll_employee_components')) {
        insertCount += 1;
        if (insertCount === 2) return Promise.reject(new Error('boom'));
      }
      return Promise.resolve([]);
    };
    await expect(applyPackageToEmployee(COMPANY_ID, PKG_ID, EMP_ID, '2026-05-01', USER_ID))
      .rejects.toThrow(/boom/);
    expect(sqlCalls.some(c => c.sql.trim() === 'ROLLBACK')).toBe(true);
  });

  it('lists by company_id', async () => {
    mockImpl = () => Promise.resolve([]);
    await listPayPackages(COMPANY_ID);
    const call = sqlCalls.find(c => c.sql.includes('FROM pay_packages'));
    expect(call!.values).toContain(COMPANY_ID);
  });
});
