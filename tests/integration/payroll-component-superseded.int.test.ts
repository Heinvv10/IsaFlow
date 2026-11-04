/**
 * Migration 953 (Hein, 2026-11-02): a supersede is RECORDED (payroll_employee_components.superseded_at, set by
 * payPackageService when an apply shortens or cancels an assignment), not inferred from a neighbouring row. The reader
 * pays a once-off whose window starts in the month and ends before its last day unless superseded_at is set; a window
 * covering the last day is paid as before, superseded or not.
 *   - Weekly once-offs (1-7, 8-14, 15-21, 22-30 November) are all paid: neighbours are no longer read as supersedes.
 *   - A package re-applied in its month pays its once-off once; cancelling the replacement does not make the replaced
 *     once-off payable again, and nothing has to refuse that any more.
 *   - The three writers (assign, batch post, package apply) take the company's payroll-approval lock first: while an
 *     approval holds it, they wait.
 * The migration is re-runnable.
 */
import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { applyPackageToEmployee } from '@/modules/accounting/services/payroll/payPackageService';
import { assignComponentToEmployee, endEmployeeComponent } from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
import { addBatchLines, createBatch, postBatch, validateBatch } from '@/modules/accounting/services/payroll/payrollBatchService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const runs = { oct: crypto.randomUUID(), nov: crypto.randomUUID() } as const;
const comp = { salary: crypto.randomUUID(), overtime: crypto.randomUUID(), bonus: crypto.randomUUID(), basic: crypto.randomUUID() };
const pkg = crypto.randomUUID();
const emp: Record<string, string> = {};
const SALARY = 20000;
const actor = () => ({ userId: user, channel: 'service' as const });

async function employee(key: string) {
  const id = crypto.randomUUID();
  emp[key] = id;
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status,medical_aid_main_member)
     VALUES($1,$2,$3,'Sup','Ersede','2020-01-01','active',false)`, [id, company, `SU-${key}`]);
  await pool.query(
    "INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from) VALUES($1,$2,$3,'2020-01-01')",
    [id, comp.salary, SALARY]);
}
const rowsOf = async (key: string, component: string) => (await pool.query(
  `SELECT id, amount::float8 AS amount, to_char(effective_from,'YYYY-MM-DD') AS f, to_char(effective_to,'YYYY-MM-DD') AS t, superseded_at
     FROM payroll_employee_components WHERE employee_id=$1 AND component_id=$2 ORDER BY effective_from, amount`, [emp[key], component])).rows;
async function paid(run: string, key: string): Promise<Array<[string, number]>> {
  await calculatePayrollRun(run, company);
  const { rows } = await pool.query('SELECT component_breakdown FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2', [run, emp[key]]);
  return (rows[0].component_breakdown as Array<{ componentName: string; amount: number }>)
    .map((c): [string, number] => [c.componentName, Number(c.amount)]).sort(([a, x], [b, y]) => a.localeCompare(b) || x - y);
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-30T12:00:00+02:00'));
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Superseded fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  for (const [id, name, code] of [[comp.salary, 'Basic salary', '3601'], [comp.overtime, 'Overtime', '3602'],
    [comp.bonus, 'Bonus', '3605'], [comp.basic, 'Package basic', '3601']]) {
    await pool.query(
      `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable,is_uif_applicable,is_sdl_applicable)
       VALUES($1,$2,$3,$4,'earning',true,true,true)`, [id, company, name, code]);
  }
  await pool.query("INSERT INTO pay_packages(id,company_id,code,name) VALUES($1,$2,'SU-PKG','Supersede package')", [pkg, company]);
  await pool.query('INSERT INTO pay_package_components(package_id,component_id,amount,is_recurring) VALUES($1,$2,1200,false),($1,$3,3000,true)',
    [pkg, comp.bonus, comp.basic]);
  for (const k of ['weekly', 'reapply', 'cancelReplacement', 'lastMonth']) await employee(k);
  for (const [from, to, amount] of [['2026-11-01', '2026-11-07', 101], ['2026-11-08', '2026-11-14', 102], ['2026-11-15', '2026-11-21', 103], ['2026-11-22', '2026-11-30', 104]] as const) {
    await assignComponentToEmployee(company, emp.weekly!, comp.overtime, amount, from, to, false, actor());
  }
  await applyPackageToEmployee(company, pkg, emp.reapply!, '2026-11-01', user);
  await applyPackageToEmployee(company, pkg, emp.reapply!, '2026-11-15', user);
  await applyPackageToEmployee(company, pkg, emp.cancelReplacement!, '2026-11-01', user);
  await applyPackageToEmployee(company, pkg, emp.cancelReplacement!, '2026-11-15', user);
  await applyPackageToEmployee(company, pkg, emp.lastMonth!, '2026-10-01', user);
  await applyPackageToEmployee(company, pkg, emp.lastMonth!, '2026-11-01', user);
  for (const [id, month] of [[runs.oct, 10], [runs.nov, 11]] as const) {
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

describe(`superseded_at, not a neighbour, decides (TZ=${process.env.TZ ?? 'unset'})`, () => {
  it('weekly once-offs (1-7, 8-14, 15-21, 22-30 November) are all paid', async () => {
    expect(await paid(runs.nov, 'weekly')).toEqual([['Basic salary', SALARY], ['Overtime', 101], ['Overtime', 102], ['Overtime', 103], ['Overtime', 104]]);
  });

  it('a package re-applied on the 15th marks the rows it cut and pays its once-off once', async () => {
    const bonus = await rowsOf('reapply', comp.bonus);
    expect(bonus.map(r => [r.f, r.t, r.superseded_at !== null])).toEqual([['2026-11-01', '2026-11-14', true], ['2026-11-15', '2026-11-30', false]]);
    expect((await rowsOf('reapply', comp.basic)).map(r => r.superseded_at !== null)).toEqual([true, false]);
    expect(await paid(runs.nov, 'reapply')).toEqual([['Basic salary', SALARY], ['Bonus', 1200], ['Package basic', 3000]]);
  });

  it('cancelling the replacement does not make the replaced once-off payable again, and is not refused', async () => {
    const [, replacement] = await rowsOf('cancelReplacement', comp.bonus);
    expect(await endEmployeeComponent(company, replacement.id, '2026-11-20', actor())).toBe(true);
    expect(await paid(runs.nov, 'cancelReplacement')).toEqual([['Basic salary', SALARY], ['Package basic', 3000]]);
  });

  it('a row superseded from the 1st of the next month is still paid in the month it covered', async () => {
    expect(await paid(runs.oct, 'lastMonth')).toEqual([['Basic salary', SALARY], ['Bonus', 1200], ['Package basic', 3000]]);
    expect(await paid(runs.nov, 'lastMonth')).toEqual([['Basic salary', SALARY], ['Bonus', 1200], ['Package basic', 3000]]);
  });
});

describe("the writers wait for the company's payroll-approval lock", () => {
  async function waitsForLock(write: () => Promise<unknown>): Promise<void> {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`payroll_approval:${company}`]);
      let done = false;
      const pending = write().then(() => { done = true; });
      await new Promise(r => setTimeout(r, 700));
      expect(done, 'the write did not wait for the approval lock').toBe(false);
      await holder.query('COMMIT');
      await pending;
      expect(done).toBe(true);
    } finally { holder.release(); }
  }

  it('assign', async () => {
    vi.useRealTimers();
    await waitsForLock(() => assignComponentToEmployee(company, emp.weekly!, comp.bonus, 50, '2026-12-03', undefined, false, actor()));
  });

  // From after the hand-entered December once-off above: an apply never cancels one of those (it is refused).
  it('pay package apply', async () => {
    await waitsForLock(() => applyPackageToEmployee(company, pkg, emp.weekly!, '2027-01-01', user));
  });

  it('batch post', async () => {
    const batch = await createBatch({ companyId: company, batchType: 'component_values', componentId: comp.overtime, description: 'SU lock',
      periodYear: 2026, periodMonth: 12, isRecurring: false, userId: user });
    await addBatchLines(company, batch.id, [{ employeeId: emp.weekly!, value: 77, effectiveFrom: new Date('2026-12-05') }]);
    expect((await validateBatch(company, batch.id)).ok).toBe(true);
    await waitsForLock(() => postBatch(company, batch.id, user));
  });
});

describe('migration 953', () => {
  it('gives up after 5s when a long transaction holds the payroll table, instead of queueing every request', async () => {
    const text = readFileSync('scripts/migrations/sql/953_payroll_component_superseded_and_calc_stamp.sql', 'utf8');
    const holder = await pool.connect();
    const runner = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE payroll_employee_components IN ACCESS SHARE MODE');
      await runner.query('BEGIN');
      const started = Date.now();
      const outcome = await Promise.race([
        runner.query(text).then(() => 'applied', (e: { code?: string }) => e.code ?? 'error'),
        new Promise<string>(r => setTimeout(() => r('still waiting'), 9000)),
      ]);
      expect(outcome).toBe('55P03');
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      await runner.query('ROLLBACK').catch(() => undefined);
      await holder.query('ROLLBACK');
      runner.release();
      holder.release();
    }
  }, 15000);

  it('re-runs cleanly (IF NOT EXISTS throughout)', async () => {
    const text = readFileSync('scripts/migrations/sql/953_payroll_component_superseded_and_calc_stamp.sql', 'utf8');
    await pool.query(text);
    await pool.query(text);
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name, column_name) IN (('payroll_employee_components','superseded_at'),('payroll_run_headers','calculated_at'),('payroll_run_headers','calculation_version'))
        ORDER BY 1, 2`);
    expect(rows).toHaveLength(3);
  });
});
