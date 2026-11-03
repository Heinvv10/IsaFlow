/** dayOf (via the service) must agree with isRealCalendarDate, including years 0001-0099 where Date.UTC maps to 19xx. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRealCalendarDate } from '@/lib/validation';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
vi.mock('@/lib/neon', () => {
  const SQL = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    sqlCalls.push({ sql: text, values });
    if (text.includes('INSERT INTO')) return Promise.resolve([{ id: 'a', employee_id: 'e', component_id: 'c', amount: '1', is_recurring: true }]);
    if (text.includes('UPDATE')) return Promise.resolve([{ id: 'a' }]);
    return Promise.resolve([{ id: 'x' }]);
  };
  return {
  sql: SQL,
  // assign and batch post now run in a transaction under the company's payroll-approval lock: the lock's two
  // statements are answered here and not recorded, everything else goes to the recorder above.
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('pg_advisory_xact_lock') || text.includes("set_config('lock_timeout'")) return Promise.resolve([{ previous: '0' }]);
    return SQL(strings, ...values);
  }),
  };
});
vi.mock('@/modules/accounting/services/payroll/payrollAssignmentWriteGuard', () => ({ refuseAssignmentWrite: vi.fn(async () => undefined) })); // covered by the integration suites
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import {
  assignComponentToEmployee, endEmployeeComponent, EmployeeComponentRefused,
} from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';

const E = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const CO = '11111111-1111-4111-8111-111111111111';
const ACTOR = { userId: 'u-1', channel: 'service' as const };
// The assignment's own INSERT (the audit row that follows it is another INSERT).
const assignInsert = () => sqlCalls.find((c) => c.sql.includes('INSERT INTO payroll_employee_components'))!;
beforeEach(() => { sqlCalls.length = 0; });

describe('dayOf agrees with isRealCalendarDate', () => {
  it.each(['2028-02-29', '2026-03-01', '2026-12-31', '2000-02-29'])('accepts %s', async (d) => {
    expect(isRealCalendarDate(d)).toBe(true);
    await expect(assignComponentToEmployee(CO, E, C, 1, d, undefined, true, ACTOR)).resolves.toBeDefined();
    expect(assignInsert().values).toContain(d);
  });

  // Through assign: End now runs in a transaction with the guarded change (payrollComponentDateEdit), which this
  // sql-only mock does not drive; End's refusals below still come from dayOf, before any transaction.
  it.each(['0050-03-01', '0004-02-29', '0099-12-31'])('accepts year-in-0001-0099 %s as isRealCalendarDate does', async (d) => {
    expect(isRealCalendarDate(d)).toBe(true);
    await expect(assignComponentToEmployee(CO, E, C, 1, d, undefined, true, ACTOR)).resolves.toBeDefined();
    expect(assignInsert().values).toContain(d);
  });

  it.each(['2026-02-29', '2100-02-29', '0050-02-30', '0001-13-01', '2026-04-31', '0000-01-01', '2026-03-01T00:00:00Z'])(
    'refuses %s', async (d) => {
      expect(isRealCalendarDate(d)).toBe(false);
      await expect(endEmployeeComponent(CO, E, d)).rejects.toBeInstanceOf(EmployeeComponentRefused);
    });
});
