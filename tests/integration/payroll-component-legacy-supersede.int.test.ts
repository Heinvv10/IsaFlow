/**
 * Rows that existed before migration 953 (supersede_inferred = TRUE) keep the reader's old supersede rule: a once-off
 * counts as superseded when another pre-953 row of the same employee and component starts the day after it ends
 * (security review, 2026-11-02). New rows use superseded_at alone. Production's read-only check found 3 Demo once-offs
 * in approved months and no open run missing a once-off; this fixture has that shape:
 *   - a pre-953 superseded pair in an approved month: paid once, as before;
 *   - an open month whose pre-953 rows form no pair: the same figures with the fallback as without it;
 *   - a new row next to a pre-953 once-off supersedes nothing; new contiguous rows are all paid;
 *   - Edit dates / End refuse a change to a pre-953 row that would revive (or drop) a pre-953 once-off;
 *   - a re-run of 953 does not mark rows created after it first ran.
 */
import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { endEmployeeComponent, EmployeeComponentRefused } from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
import { updateEmployeeComponentDates } from '@/modules/accounting/services/payroll/payrollComponentDateEdit';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const runs = { sep: crypto.randomUUID(), nov: crypto.randomUUID() } as const;
const salary = crypto.randomUUID();
const bonus = crypto.randomUUID();
const emp: Record<string, string> = {};
const rows: Record<string, string> = {};
const actor = { userId: user, channel: 'service' as const };

async function employee(key: string) {
  emp[key] = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status,medical_aid_main_member)
     VALUES($1,$2,$3,'Leg','Acy','2020-01-01','active',false)`, [emp[key], company, `LG-${key}`]);
  await add(key, `${key}-salary`, salary, 20000, '2020-01-01', null, true, true);
}
async function add(key: string, name: string, component: string, amount: number, from: string, to: string | null, recurring: boolean, legacy: boolean) {
  rows[name] = String((await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring,supersede_inferred)
     VALUES($1,$2,$3,$4::date,$5::date,$6,$7) RETURNING id`, [emp[key], component, amount, from, to, recurring, legacy])).rows[0]!.id);
}
async function lineOf(run: string, key: string) {
  await calculatePayrollRun(run, company);
  const { rows: r } = await pool.query(
    'SELECT gross_pay, paye, net_pay, component_breakdown::text AS b FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2', [run, emp[key]]);
  return r[0];
}
const bonuses = async (run: string, key: string) =>
  (JSON.parse((await lineOf(run, key)).b) as Array<{ componentName: string; amount: number }>)
    .filter(c => c.componentName === 'Bonus').map(c => Number(c.amount)).sort((a, b) => a - b);

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-30T12:00:00+02:00'));
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Legacy supersede fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  for (const [id, name, code] of [[salary, 'Basic salary', '3601'], [bonus, 'Bonus', '3605']]) {
    await pool.query(
      `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable,is_uif_applicable,is_sdl_applicable)
       VALUES($1,$2,$3,$4,'earning',true,true,true)`, [id, company, name, code]);
  }
  // A pre-953 package re-apply in September (an approved month in production): the old once-off cut on the 14th.
  await employee('legacyPair');
  await add('legacyPair', 'oldOnce', bonus, 1200, '2026-09-01', '2026-09-14', false, true);
  await add('legacyPair', 'newOnce', bonus, 1200, '2026-09-15', '2026-09-30', false, true);
  // November, open: pre-953 rows forming no pair.
  await employee('openMonth');
  await add('openMonth', 'openShort', bonus, 450, '2026-11-05', '2026-11-12', false, true);
  await add('openMonth', 'openFull', bonus, 300, '2026-11-01', '2026-11-30', false, true);
  // A pre-953 once-off with a post-953 row of the same component from the next day.
  await employee('mixed');
  await add('mixed', 'mixedOld', bonus, 500, '2026-11-01', '2026-11-14', false, true);
  await add('mixed', 'mixedNew', bonus, 600, '2026-11-15', '2026-11-30', false, false);
  for (const [id, month] of [[runs.sep, 9], [runs.nov, 11]] as const) {
    await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,$3,2026,'draft')", [id, company, month]);
  }
});

afterAll(async () => {
  vi.useRealTimers();
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id=ANY($1::uuid[])', [Object.values(runs)]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id=ANY($1::uuid[])', [Object.values(emp)]);
    await pool.query('DELETE FROM payroll_components WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe(`pre-953 rows keep the inferred supersede (TZ=${process.env.TZ ?? 'unset'})`, () => {
  it('a pre-953 re-apply pair pays its once-off once', async () => {
    expect(await bonuses(runs.sep, 'legacyPair')).toEqual([1200]);
  });

  it('an open month with pre-953 rows forming no pair: the same figures with the fallback as without it', async () => {
    const withFallback = await lineOf(runs.nov, 'openMonth');
    await pool.query('UPDATE payroll_employee_components SET supersede_inferred = FALSE WHERE employee_id=$1', [emp.openMonth]);
    const without = await lineOf(runs.nov, 'openMonth');
    await pool.query('UPDATE payroll_employee_components SET supersede_inferred = TRUE WHERE employee_id=$1', [emp.openMonth]);
    expect(withFallback).toEqual(without);
    expect(await bonuses(runs.nov, 'openMonth')).toEqual([300, 450]);
  });

  it('a post-953 row next to a pre-953 once-off supersedes nothing: both are paid', async () => {
    expect(await bonuses(runs.nov, 'mixed')).toEqual([500, 600]);
  });
});

describe('Edit dates and End do not revive a pre-953 superseded once-off', () => {
  it.each([
    ['moving the successor start', () => updateEmployeeComponentDates(company, rows.newOnce!, '2026-09-16', '2026-09-30', actor)],
    ["moving the old once-off's end", () => updateEmployeeComponentDates(company, rows.oldOnce!, '2026-09-01', '2026-09-13', actor)],
    ['cancelling the successor', () => endEmployeeComponent(company, rows.newOnce!, '2026-09-20', actor)],
  ])('%s: refused, nothing written', async (_n, change) => {
    const before = (await pool.query('SELECT effective_from, effective_to FROM payroll_employee_components WHERE employee_id=$1 ORDER BY id', [emp.legacyPair])).rows;
    await expect(change()).rejects.toBeInstanceOf(EmployeeComponentRefused);
    await expect(change()).rejects.toThrow(/paid again/);
    expect((await pool.query('SELECT effective_from, effective_to FROM payroll_employee_components WHERE employee_id=$1 ORDER BY id', [emp.legacyPair])).rows).toEqual(before);
  });
});

describe('migration 953 re-run', () => {
  it('does not mark rows created after it first ran', async () => {
    await pool.query(readFileSync('scripts/migrations/sql/953_payroll_component_superseded_and_calc_stamp.sql', 'utf8'));
    const { rows: r } = await pool.query('SELECT supersede_inferred FROM payroll_employee_components WHERE id=$1', [rows.mixedNew]);
    expect(r[0].supersede_inferred).toBe(false);
  });
});
