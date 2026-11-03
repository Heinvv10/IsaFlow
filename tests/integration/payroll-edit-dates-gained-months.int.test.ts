/**
 * Edit dates names the paid months a row would GAIN, not a date to move it to: whether a given date is followable
 * depends on the row's other end and the other rows, so none is promised. A month the row already touched is not named.
 * (Assign names a date: there the whole window is the caller's choice, and it is followed in
 * payroll-recurring-paid-month-advice.int.test.ts.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { updateEmployeeComponentDates } from '@/modules/accounting/services/payroll/payrollComponentDateEdit';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const actor = { userId: user, channel: 'service' as const };
const emp: Record<string, string> = {};
const comp: Record<string, string> = {};
const row: Record<string, string> = {};

async function employee(key: string) {
  emp[key] = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status,medical_aid_main_member)
     VALUES($1,$2,$3,'Gained','Months','2026-01-01','active',false)`, [emp[key], company, `GM-${key}`]);
}
async function paidMonth(month: number, who: string[]) {
  const id = crypto.randomUUID();
  await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,$3,2026,'approved')", [id, company, month]);
  await pool.query('UPDATE payroll_run_headers SET calculated_at = now() WHERE id=$1', [id]);
  for (const key of who) await pool.query('INSERT INTO payroll_run_lines(run_id,employee_id,gross_pay,taxable_income,paye,net_pay) VALUES($1,$2,100,100,0,100)', [id, emp[key]]);
}
async function addRow(key: string, who: string, from: string, to: string | null) {
  comp[key] = crypto.randomUUID();
  await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,$3,'3713','earning')", [comp[key], company, key]);
  row[key] = String((await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring,supersede_inferred)
     VALUES($1,$2,100,$3::date,$4::date,TRUE,FALSE) RETURNING id`, [emp[who], comp[key], from, to])).rows[0]!.id);
}
const edit = (key: string, from: string, to: string | null) => updateEmployeeComponentDates(company, row[key]!, from, to, actor).then(() => null, (e) => e as Error);

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Edit dates gained months']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  for (const key of ['onMarch', 'other', 'onJune']) await employee(key);
  await paidMonth(2, ['other']);
  await paidMonth(3, ['onMarch']);
  await paidMonth(6, ['onJune']);
  await addRow('stretchBack', 'onMarch', '2026-03-01', '2026-04-30');
  await addRow('extendForward', 'other', '2026-04-01', '2026-04-30');
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id IN (SELECT id FROM payroll_employees WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM payroll_components WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('Edit dates names the gained paid months, and no date', () => {
  it('a row on the March run stretched back into February: names 2026-02 only (not March, which it already touched)', async () => {
    const err = await edit('stretchBack', '2026-02-01', '2026-04-30');
    expect(err?.message).toMatch(/^2026-02 is already paid \(approved run\)/);
    expect(err?.message).toMatch(/Keep the row out of 2026-02; or reopen that run and reverse its journal first, or capture the correction in an open period/);
    expect(err?.message).not.toMatch(/2026-03/);
    expect(err?.message).not.toMatch(/\d{4}-\d\d-\d\d/);
    expect(err?.message).not.toMatch(/Date it from/);
  });

  it('a row extended forward into a paid June: names 2026-06 only', async () => {
    const err = await edit('extendForward', '2026-04-01', '2026-06-30');
    expect(err?.message).toMatch(/^2026-06 is already paid/);
    expect(err?.message).toMatch(/Keep the row out of 2026-06;/);
    expect(err?.message).not.toMatch(/Date it from|\d{4}-\d\d-\d\d/);
  });

  it('gaining two paid months names both', async () => {
    const err = await edit('stretchBack', '2026-02-01', '2026-06-30');
    expect(err?.message).toMatch(/^2026-02 and 2026-06 are already paid/);
    expect(err?.message).toMatch(/Keep the row out of 2026-02 and 2026-06;/);
  });

  it('an edit that gains no paid month is accepted', async () => {
    expect(await edit('extendForward', '2026-04-01', '2026-05-31')).toBeNull();
  });
});
