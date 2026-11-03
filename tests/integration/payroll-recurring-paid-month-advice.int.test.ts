/**
 * A recurring row refused for a paid month says where to date it from: the first day of the month after the latest paid
 * month it would reach (March and May paid: "Date it from 2026-06-01"). Following the date is accepted. A bounded row
 * that ends before that date has nowhere to move to, so it is told only to use an open month.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { assignComponentToEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const employee = crypto.randomUUID();
const component = crypto.randomUUID();
const user = crypto.randomUUID();
const actor = { userId: user, channel: 'service' as const };
const assign = (from: string, to?: string) => assignComponentToEmployee(company, employee, component, 100, from, to, true, actor);

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Recurring paid-month advice']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status,medical_aid_main_member)
     VALUES($1,$2,'RA-1','Re','Advice','2026-01-01','active',false)`, [employee, company]);
  await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Allowance','3713','earning')", [component, company]);
  for (const month of [3, 5]) {
    await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,$3,2026,'approved')", [crypto.randomUUID(), company, month]);
  }
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id=$1', [employee]);
    await pool.query('DELETE FROM payroll_components WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('Date it from …', () => {
  it.each([['2026-03-10'], ['2026-04-01']])('open-ended from %s (March and May paid): from 1 June, and 1 June is accepted', async (from) => {
    const err = await assign(from).then(() => null, (e) => e as Error);
    expect(err?.message).toMatch(/Date it from 2026-06-01; or reopen that run and reverse its journal first, or capture the correction in an open period/);
    await expect(assign('2026-06-01')).resolves.toBeDefined();
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id=$1', [employee]);
  });

  it('a bounded row that ends before the date has nowhere to go: told to use an open month', async () => {
    const err = await assign('2026-03-10', '2026-03-31').then(() => null, (e) => e as Error);
    expect(err?.message).toMatch(/Date it in an open month; or reopen that run/);
    await expect(assign('2026-04-01', '2026-04-30')).resolves.toBeDefined();
  });
});
