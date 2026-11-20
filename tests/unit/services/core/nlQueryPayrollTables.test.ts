/**
 * #1656 round 7 (LOW): the natural-language query's payroll refusal (a person without Payroll read) covers the leave tables and the pay
 * fields of a project time entry (hourly_rate, billable_amount, or a SELECT * that returns them), as well as payslips and employees.
 */
import { describe, expect, it } from 'vitest';
import { PAYROLL_NL_TABLES, sqlTouchesPayrollTables } from '@/modules/accounting/services/core/nlQueryPayrollTables';

describe('sqlTouchesPayrollTables', () => {
  it.each([
    'SELECT * FROM payslips',
    'SELECT first_name FROM employees',
    'SELECT * FROM leave_balances WHERE company_id = $1',
    'SELECT employee_id FROM leave_applications',
    'SELECT hourly_rate FROM project_time_entries',
    'SELECT SUM(billable_amount) FROM project_time_entries',
    'SELECT * FROM project_time_entries',
    'SELECT t.* FROM project_time_entries t',
  ])('refuses: %s', (sql) => expect(sqlTouchesPayrollTables(sql)).toBe(true));

  it.each([
    'SELECT SUM(hours) FROM project_time_entries WHERE entry_date >= $1',
    'SELECT COUNT(*) FROM project_time_entries',
    'SELECT project_id, hours FROM project_time_entries',
    'SELECT * FROM customers',
    'SELECT COUNT(*) FROM leave_types',
  ])('lets through: %s', (sql) => expect(sqlTouchesPayrollTables(sql)).toBe(false));

  it('hides the leave tables from the prompt too', () => {
    expect([...PAYROLL_NL_TABLES]).toEqual(expect.arrayContaining(['employees', 'payslips', 'leave_balances', 'leave_applications']));
  });
});
