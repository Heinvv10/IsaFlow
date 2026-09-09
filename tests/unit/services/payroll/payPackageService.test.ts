import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[]; viaTx?: boolean }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

const warnSpy = vi.fn();
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  return { ...actual, log: { ...actual.log, info: () => {}, warn: (...args: unknown[]) => warnSpy(...args) } };
});

vi.mock('@/lib/neon', () => ({
  // withTransaction replaces the raw BEGIN/COMMIT the services used to emit.
  //
  // The `tx` handed to the callback records with `viaTx: true` so a statement
  // issued INSIDE the transaction is distinguishable from one issued bare
  // through `sql`. Without that marker the two are identical in this log, and a
  // regression that dropped withTransaction entirely — leaving a mid-loop
  // failure to strand a DELETE with no INSERTs — would pass every test here.
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ sql: strings.join('?'), values, viaTx: true });
      return mockImpl(strings, ...values);
    },
  ),
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
  warnSpy.mockClear();
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
    // No BEGIN/COMMIT: the service no longer emits them. `sql` routes onto the
    // request's ALS client, so a raw COMMIT committed the WHOLE request;
    // withTransaction nests a SAVEPOINT, which is not a statement in this log.
    expect(sqlCalls.some(c => c.sql.trim() === 'BEGIN')).toBe(false);
    expect(sqlCalls.some(c => c.sql.includes('DELETE FROM pay_package_components'))).toBe(true);
    expect(sqlCalls.filter(c => c.sql.includes('INSERT INTO pay_package_components')).length).toBe(2);
    expect(sqlCalls.some(c => c.sql.trim() === 'COMMIT')).toBe(false);
    // Writes went through the TRANSACTION, not bare `sql`.
    const writes = sqlCalls.filter(c => /INSERT INTO (pay_package_components|payroll_employee_components)|DELETE FROM pay_package_components|UPDATE payroll_employee_components/.test(c.sql));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every(c => c.viaTx === true)).toBe(true);
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
    // No BEGIN/COMMIT: the service no longer emits them. `sql` routes onto the
    // request's ALS client, so a raw COMMIT committed the WHOLE request;
    // withTransaction nests a SAVEPOINT, which is not a statement in this log.
    expect(sqlCalls.some(c => c.sql.trim() === 'BEGIN')).toBe(false);
    expect(sqlCalls.filter(c => c.sql.includes('UPDATE payroll_employee_components')).length).toBe(2);
    expect(sqlCalls.filter(c => c.sql.includes('INSERT INTO payroll_employee_components')).length).toBe(2);
    expect(sqlCalls.some(c => c.sql.trim() === 'COMMIT')).toBe(false);
    // Writes went through the TRANSACTION, not bare `sql`.
    const writes = sqlCalls.filter(c => /INSERT INTO (pay_package_components|payroll_employee_components)|DELETE FROM pay_package_components|UPDATE payroll_employee_components/.test(c.sql));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every(c => c.viaTx === true)).toBe(true);
  });

  it('closes a once-off package row at the end of effectiveFrom month, leaves a recurring one open', async () => {
    // The payroll reader (getEmployeeComponents) filters on the date window and
    // ignores is_recurring, so an open-ended once-off row is paid every month.
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID }]);
      if (q.includes('FROM pay_packages')) return Promise.resolve([{ id: PKG_ID }]);
      if (q.includes('FROM pay_package_components')) {
        return Promise.resolve([
          { component_id: COMP_A, amount: '10000', is_recurring: true },
          { component_id: COMP_B, amount: '5000', is_recurring: false },
        ]);
      }
      return Promise.resolve([]);
    };
    await applyPackageToEmployee(COMPANY_ID, PKG_ID, EMP_ID, '2026-05-01', USER_ID);
    const inserts = sqlCalls.filter(c => c.sql.includes('INSERT INTO payroll_employee_components'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.sql).toContain('effective_to');
    expect(inserts[0]!.values).toContain(null);          // recurring stays open-ended
    expect(inserts[1]!.values).toContain('2026-05-31');  // once-off closes at month end
    // The supersede must reach the already-closed once-off row too, or a second
    // apply in the same month leaves two overlapping windows and pays it twice.
    const supersedes = sqlCalls.filter(c => c.sql.includes('UPDATE payroll_employee_components'));
    expect(supersedes).toHaveLength(2);
    for (const call of supersedes) {
      expect(call.sql).toContain('effective_to IS NULL OR effective_to >=');
    }
  });

  it('warns, naming the rows, when the apply cancels an assignment it fully overlaps', async () => {
    // A row starting on or after effectiveFrom is not shortened, it is voided:
    // the new effective_to lands before its effective_from. Intended, but a
    // future-dated assignment vanishing from a period nobody is looking at yet
    // must not be silent.
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID }]);
      if (q.includes('FROM pay_packages')) return Promise.resolve([{ id: PKG_ID }]);
      if (q.includes('FROM pay_package_components')) {
        return Promise.resolve([{ component_id: COMP_A, amount: '10000', is_recurring: true }]);
      }
      if (q.includes('UPDATE payroll_employee_components')) {
        return Promise.resolve([
          { id: 'shortened', effective_from: '2026-01-01' },  // starts before → shortened
          { id: 'cancelled', effective_from: '2026-06-01' },  // starts after  → voided
        ]);
      }
      return Promise.resolve([]);
    };

    await applyPackageToEmployee(COMPANY_ID, PKG_ID, EMP_ID, '2026-05-01', USER_ID);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, data] = warnSpy.mock.calls[0]! as [string, { cancelled: Array<{ id: string }> }];
    expect(data.cancelled.map(c => c.id)).toEqual(['cancelled']);
  });

  it('does not warn when every superseded row is merely shortened', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID }]);
      if (q.includes('FROM pay_packages')) return Promise.resolve([{ id: PKG_ID }]);
      if (q.includes('FROM pay_package_components')) {
        return Promise.resolve([{ component_id: COMP_A, amount: '10000', is_recurring: true }]);
      }
      if (q.includes('UPDATE payroll_employee_components')) {
        return Promise.resolve([{ id: 'shortened', effective_from: '2026-01-01' }]);
      }
      return Promise.resolve([]);
    };

    await applyPackageToEmployee(COMPANY_ID, PKG_ID, EMP_ID, '2026-05-01', USER_ID);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('propagates a failure so the surrounding transaction unwinds', async () => {
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
    // Rollback is withTransaction's savepoint, not a statement this service
    // emits. What the service owes its caller is that the error PROPAGATES.
    expect(sqlCalls.some(c => c.sql.trim() === 'ROLLBACK')).toBe(false);
  });

  it('lists by company_id', async () => {
    mockImpl = () => Promise.resolve([]);
    await listPayPackages(COMPANY_ID);
    const call = sqlCalls.find(c => c.sql.includes('FROM pay_packages'));
    expect(call!.values).toContain(COMPANY_ID);
  });
});
