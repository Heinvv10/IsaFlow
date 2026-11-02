/**
 * Migration 953 review (2026-11-02): supersede_inferred defaults to TRUE, so a row inserted without the column (code
 * from before this release, during the deploy window or after a code-only rollback) is read with the old neighbour
 * rule and a once-off it replaced cannot be paid twice. Every writer in this release writes FALSE explicitly.
 * A package re-applied over a pre-953 replaced pair (A 1-14 replaced by B 15-30, re-applied from the 15th) cuts B, and
 * so marks A superseded in the same transaction: A is not paid, the package's once-off is paid once.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { applyPackageToEmployee } from '@/modules/accounting/services/payroll/payPackageService';
import { assignComponentToEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
import { addBatchLines, createBatch, postBatch, validateBatch } from '@/modules/accounting/services/payroll/payrollBatchService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const run = crypto.randomUUID();
const salary = crypto.randomUUID();
const bonus = crypto.randomUUID();
const pkg = crypto.randomUUID();
const emp: Record<string, string> = {};
const row: Record<string, string> = {};
const actor = { userId: user, channel: 'service' as const };

async function employee(key: string) {
  emp[key] = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status,medical_aid_main_member)
     VALUES($1,$2,$3,'Old','Code','2020-01-01','active',false)`, [emp[key], company, `OC-${key}`]);
}
/** As code from before 953 inserts: supersede_inferred not named, so its default applies. */
async function oldInsert(name: string, key: string, from: string, to: string) {
  row[name] = String((await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
     VALUES($1,$2,1200,$3::date,$4::date,false) RETURNING id`, [emp[key], bonus, from, to])).rows[0]!.id);
}
const flag = async (id: string) => (await pool.query('SELECT supersede_inferred, superseded_at FROM payroll_employee_components WHERE id=$1', [id])).rows[0];
async function bonuses(key: string): Promise<number[]> {
  await calculatePayrollRun(run, company);
  const { rows } = await pool.query('SELECT component_breakdown FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2', [run, emp[key]]);
  return (rows[0]?.component_breakdown as Array<{ componentName: string; amount: number }> ?? [])
    .filter(c => c.componentName === 'Bonus').map(c => Number(c.amount));
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-30T12:00:00+02:00'));
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Legacy writers fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  for (const [id, name, code] of [[salary, 'Basic salary', '3601'], [bonus, 'Bonus', '3605']]) {
    await pool.query(
      `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable,is_uif_applicable,is_sdl_applicable)
       VALUES($1,$2,$3,$4,'earning',true,true,true)`, [id, company, name, code]);
  }
  await pool.query("INSERT INTO pay_packages(id,company_id,code,name) VALUES($1,$2,'OC-PKG','Old-code package')", [pkg, company]);
  await pool.query('INSERT INTO pay_package_components(package_id,component_id,amount,is_recurring) VALUES($1,$2,1200,false)', [pkg, bonus]);
  await employee('oldPair');
  await oldInsert('oldA', 'oldPair', '2026-11-01', '2026-11-14');
  await oldInsert('oldB', 'oldPair', '2026-11-15', '2026-11-30');
  await employee('reapply');
  await oldInsert('reA', 'reapply', '2026-11-01', '2026-11-14');
  await oldInsert('reB', 'reapply', '2026-11-15', '2026-11-30');
  await employee('writers');
  await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,11,2026,'draft')", [run, company]);
});

afterAll(async () => {
  vi.useRealTimers();
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id=$1', [run]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id=ANY($1::uuid[])', [Object.values(emp)]);
    await pool.query('DELETE FROM payroll_batch_lines WHERE batch_id IN (SELECT id FROM payroll_batches WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM payroll_batches WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM pay_package_components WHERE package_id=$1', [pkg]);
    await pool.query('DELETE FROM pay_packages WHERE id=$1', [pkg]);
    await pool.query('DELETE FROM payroll_components WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe(`rows inserted by old code read with the old rule (TZ=${process.env.TZ ?? 'unset'})`, () => {
  it('a row inserted without the column defaults to supersede_inferred = TRUE', async () => {
    expect((await flag(row.oldA!)).supersede_inferred).toBe(true);
  });

  it('an old-code replaced pair (1-14, 15-30) pays its once-off once', async () => {
    expect(await bonuses('oldPair')).toEqual([1200]);
  });
});

describe('a package re-applied from the 15th over a pre-953 replaced pair', () => {
  it('cuts B and marks A superseded in the same apply: A is not paid, the new once-off once', async () => {
    await applyPackageToEmployee(company, pkg, emp.reapply!, '2026-11-15', user);
    const a = await flag(row.reA!);
    expect(a.superseded_at).not.toBeNull();
    expect(await bonuses('reapply')).toEqual([1200]);
  });
});

describe('every writer in this release writes supersede_inferred = FALSE', () => {
  it('assign, package apply and batch post', async () => {
    const assigned = await assignComponentToEmployee(company, emp.writers!, bonus, 50, '2026-12-01', undefined, false, actor);
    await applyPackageToEmployee(company, pkg, emp.writers!, '2027-01-10', user);
    const batch = await createBatch({ companyId: company, batchType: 'component_values', componentId: salary, description: 'OC batch',
      periodYear: 2027, periodMonth: 2, isRecurring: false, userId: user });
    await addBatchLines(company, batch.id, [{ employeeId: emp.writers!, value: 70, effectiveFrom: new Date('2027-02-05') }]);
    expect((await validateBatch(company, batch.id)).ok).toBe(true);
    await postBatch(company, batch.id, user);
    const { rows } = await pool.query('SELECT supersede_inferred FROM payroll_employee_components WHERE employee_id=$1', [emp.writers]);
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.supersede_inferred === false)).toBe(true);
    expect((await flag(assigned.id)).supersede_inferred).toBe(false);
  });
});
