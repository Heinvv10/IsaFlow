/**
 * The MCP payroll write tools, driven through the REAL tool handlers and the REAL services, with only `sql`
 * captured. Runs under TZ=Africa/Johannesburg (set below, before any Date is built): a local-midnight Date
 * rendered through toISOString() is the previous day there, which stored every assigned component one day early.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.hoisted(() => { process.env.TZ = 'Africa/Johannesburg'; });

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    sqlCalls.push({ sql: text, values });
    if (text.includes('FROM payroll_employees') && text.includes('SELECT id')) return Promise.resolve([{ id: 'x' }]);
    if (text.includes('FROM payroll_components')) return Promise.resolve([{ id: 'x' }]);
    if (text.includes('INSERT INTO payroll_employee_components')) {
      return Promise.resolve([{ id: ASSIGNMENT, employee_id: EMPLOYEE, component_id: COMPONENT, amount: '1', is_recurring: true }]);
    }
    if (text.includes('UPDATE payroll_employee_components')) return Promise.resolve([{ id: ASSIGNMENT }]);
    if (text.includes('INSERT INTO payroll_employees')) {
      return Promise.resolve([{ id: EMPLOYEE, company_id: COMPANY, employee_number: 'E1', first_name: 'A', last_name: 'B', employment_type: 'permanent', start_date: '2026-03-01' }]);
    }
    return Promise.resolve([]);
  },
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getPayrollEmployee: vi.fn(async () => ({ id: 'e' })),
}));
vi.mock('@/modules/accounting/services/payroll/payrollComponentService', () => ({
  listComponents: vi.fn(async () => [{ id: COMPONENT, name: 'Basic', componentType: 'earning' }]),
}));

import {
  assignEmployeeComponentTool, createEmployeeTool, endEmployeeComponentTool,
} from '@/lib/mcp/tools/writeEmployees';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE = '22222222-2222-4222-8222-222222222222';
const COMPONENT = '33333333-3333-4333-8333-333333333333';
const ASSIGNMENT = '44444444-4444-4444-8444-444444444444';
const ctx = { userId: '55555555-5555-4555-8555-555555555555', companyId: COMPANY, scopes: ['write:payroll'], tokenJti: 'j', oauthAppId: null } as McpToolContext;

const insertValues = () => sqlCalls.find((c) => c.sql.includes('INSERT INTO payroll_employee_components'))!.values;
const assign = (over: Record<string, unknown>) => assignEmployeeComponentTool.handler(
  { employee_id: EMPLOYEE, component_id: COMPONENT, amount: 100, idempotency_key: 'k', ...over }, ctx);

beforeAll(() => {
  // Precondition: this process really is east of UTC, so the old code path is observable.
  expect(new Date(2026, 2, 1).toISOString().slice(0, 10)).toBe('2026-02-28');
});
beforeEach(() => { sqlCalls.length = 0; });

describe('assign_employee_component stores the date it was given (SAST)', () => {
  it('recurring from the 1st', async () => {
    const r = await assign({ effective_from: '2026-03-01' });
    expect(r.isError).toBeFalsy();
    expect(insertValues()).toContain('2026-03-01');
    expect(insertValues()).not.toContain('2026-02-28');
  });

  it('once-off from the 1st lands in its own month, not the previous one', async () => {
    await assign({ effective_from: '2026-03-01', is_recurring: false });
    const v = insertValues();
    expect(v).toContain('2026-03-01');
    expect(v).toContain('2026-03-31');
    expect(v).not.toContain('2026-02-28');
  });

  it('once-off from the last day of a month closes that month', async () => {
    await assign({ effective_from: '2026-03-31', is_recurring: false });
    expect(insertValues()).toEqual(expect.arrayContaining(['2026-03-31']));
    expect(insertValues()).not.toContain('2026-03-30');
  });

  it('an explicit effective_to is stored as given', async () => {
    await assign({ effective_from: '2026-01-01', effective_to: '2026-06-01' });
    expect(insertValues()).toEqual(expect.arrayContaining(['2026-01-01', '2026-06-01']));
  });
});

describe('the other MCP date writes agree', () => {
  it('end_employee_component stores effective_to as given', async () => {
    await endEmployeeComponentTool.handler(
      { assignment_id: ASSIGNMENT, effective_to: '2026-03-01', idempotency_key: 'k' }, ctx);
    const upd = sqlCalls.find((c) => c.sql.includes('UPDATE payroll_employee_components'))!;
    expect(upd.values).toContain('2026-03-01');
  });

  it('create_employee stores start_date, end_date and date_of_birth as given', async () => {
    const r = await createEmployeeTool.handler({
      employee_number: 'E1', first_name: 'A', last_name: 'B', employment_type: 'permanent',
      start_date: '2026-03-01', end_date: '2026-09-01', date_of_birth: '1990-01-01', idempotency_key: 'k',
    }, ctx);
    expect(r.isError).toBeFalsy();
    const ins = sqlCalls.find((c) => c.sql.includes('INSERT INTO payroll_employees'))!;
    expect(ins.values).toEqual(expect.arrayContaining(['2026-03-01', '2026-09-01', '1990-01-01']));
  });
});
