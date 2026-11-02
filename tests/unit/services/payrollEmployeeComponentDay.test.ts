/** dayOf (via the service) must agree with isRealCalendarDate, including years 0001-0099 where Date.UTC maps to 19xx. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRealCalendarDate } from '@/lib/validation';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    sqlCalls.push({ sql: text, values });
    if (text.includes('INSERT INTO')) return Promise.resolve([{ id: 'a', employee_id: 'e', component_id: 'c', amount: '1', is_recurring: true }]);
    if (text.includes('UPDATE')) return Promise.resolve([{ id: 'a' }]);
    return Promise.resolve([{ id: 'x' }]);
  },
}));
// The company payroll lock (payrollRunLock), recorded in the same trail, so its place among the statements is judged.
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({
  lockCompanyPayrollApprovals: vi.fn(async () => { sqlCalls.push({ sql: 'LOCK company payroll', values: [] }); }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import {
  assignComponentToEmployee, endEmployeeComponent, EmployeeComponentRefused,
} from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';

const E = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const CO = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { sqlCalls.length = 0; });

describe('a date that is not a string', () => {
  it.each([[['2026-03-01']], [20260301], [null], [{ toString: () => '2026-03-01' }]])('%j is refused before any lock or query', async (d) => {
    await expect(assignComponentToEmployee(CO, E, C, 1, d as never)).rejects.toBeInstanceOf(EmployeeComponentRefused);
    // A null end date means "no end date"; any other non-string end date is refused.
    if (d !== null) await expect(assignComponentToEmployee(CO, E, C, 1, '2026-03-01', d as never)).rejects.toBeInstanceOf(EmployeeComponentRefused);
    await expect(endEmployeeComponent(CO, E, d as never)).rejects.toBeInstanceOf(EmployeeComponentRefused);
    expect(sqlCalls).toEqual([]);
  });
});

describe('dayOf agrees with isRealCalendarDate', () => {
  it.each(['2028-02-29', '2026-03-01', '2026-12-31', '2000-02-29'])('accepts %s', async (d) => {
    expect(isRealCalendarDate(d)).toBe(true);
    await expect(assignComponentToEmployee(CO, E, C, 1, d)).resolves.toBeDefined();
    expect(sqlCalls.at(-1)!.values).toContain(d);
    const lock = sqlCalls.findIndex((c) => c.sql.startsWith('LOCK'));
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(sqlCalls.findIndex((c) => c.sql.includes('INSERT INTO')));
  });

  it.each(['0050-03-01', '0004-02-29', '0099-12-31'])('accepts year-in-0001-0099 %s as isRealCalendarDate does', async (d) => {
    expect(isRealCalendarDate(d)).toBe(true);
    await expect(endEmployeeComponent(CO, E, d)).resolves.toBe(true);
  });

  it.each(['2026-02-29', '2100-02-29', '0050-02-30', '0001-13-01', '2026-04-31', '0000-01-01', '2026-03-01T00:00:00Z'])(
    'refuses %s', async (d) => {
      expect(isRealCalendarDate(d)).toBe(false);
      await expect(endEmployeeComponent(CO, E, d)).rejects.toBeInstanceOf(EmployeeComponentRefused);
      await expect(assignComponentToEmployee(CO, E, C, 1, d)).rejects.toBeInstanceOf(EmployeeComponentRefused);
      // The date is judged first: a refused one takes no lock and reads nothing.
      expect(sqlCalls).toEqual([]);
    });
});
