/**
 * The pro-rata guard (Hein, 2026-11-02). A run reads components on its period's last day and does not apportion, so a
 * RECURRING row that starts after the 27th of the run month is paid in full, and one that ends from the 27th to the day
 * before the last day is not paid at all. Neither may happen silently: the employee's line carries
 * RECURRING_NEEDS_PRO_RATA (component, date, "needs a manual pro-rata"), and approval is refused with
 * `recurring_needs_pro_rata`, naming each employee, until the row's dates are changed and the run recalculated.
 * IsaFlow has no per-employee hold, so the refusal is for the whole run. The guard changes no figure.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, seedPayrollCompany } from './w3-01-payroll.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { judgePayrollApproval } from '@/modules/accounting/services/payroll/payrollApprovalGate';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const runs = { feb: crypto.randomUUID(), mar: crypto.randomUUID(), apr: crypto.randomUUID(), otherMar: crypto.randomUUID() };
const CODE = 'RECURRING_NEEDS_PRO_RATA';
let salary = '';
let bonus = '';
const ids: Record<string, string> = {};

async function employee(num: string, start: string, rows: Array<[number, string, string | null, boolean?]>) {
  const id = crypto.randomUUID();
  ids[num] = id;
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status,medical_aid_main_member)
     VALUES($1,$2,$3,'Pro','Rata',$4::date,'active',false)`, [id, company, num, start]);
  for (const [amount, from, to, recurring = true] of rows) {
    await pool.query(
      `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
       VALUES($1,$2,$3,$4::date,$5::date,$6)`, [id, recurring ? salary : bonus, amount, from, to, recurring]);
  }
}

async function line(run: string, num: string) {
  const { rows } = await pool.query(
    'SELECT gross_pay::float8 AS gross, validation_results FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2', [run, ids[num]]);
  const flags = (rows[0].validation_results as Array<{ code: string; severity: string; message: string }>).filter(v => v.code === CODE);
  return { gross: Number(rows[0].gross), flags };
}

const blockerOf = async (companyId: string, run: string) => (await judgePayrollApproval(companyId, run))?.blocker ?? null;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-04-30T12:00:00+02:00'));
  for (const [id, name] of [[company, 'Pro-rata guard'], [other, 'Pro-rata other tenant']]) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
    await seedPayrollCompany(pool, id);
  }
  salary = String((await pool.query("SELECT id FROM payroll_components WHERE company_id=$1", [company])).rows[0].id);
  bonus = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Once-off bonus','3605','earning')`,
    [bonus, company]);

  await employee('PR-STARTS28', '2026-03-28', [[20000, '2026-03-28', null]]);
  await employee('PR-WITHIN', '2020-01-01', [[20000, '2026-03-28', '2026-03-29']]);
  await employee('PR-ENDS27', '2020-01-01', [[20000, '2020-01-01', '2026-03-27']]);
  await employee('PR-ENDS30', '2020-01-01', [[20000, '2020-01-01', '2026-03-30']]);
  await employee('PR-STARTS27', '2026-03-27', [[20000, '2026-03-27', null]]);
  await employee('PR-ENDS26', '2020-01-01', [[20000, '2020-01-01', '2026-03-26']]);
  await employee('PR-ENDS31', '2020-01-01', [[20000, '2020-01-01', '2026-03-31']]);
  await employee('PR-ONCEOFF30', '2020-01-01', [[20000, '2020-01-01', null], [500, '2026-03-30', '2026-03-31', false]]);
  await employee('PR-VOIDED', '2020-01-01', [[20000, '2020-01-01', null], [900, '2026-03-30', '2026-03-29']]);
  await employee('PR-FEB28', '2026-02-28', [[20000, '2026-02-28', null]]);
  // The other tenant: same shape, flagged in its own run only.
  await pool.query("UPDATE payroll_employee_components SET effective_to='2026-03-29' WHERE employee_id IN (SELECT id FROM payroll_employees WHERE company_id=$1)", [other]);

  for (const [id, co, month] of [[runs.feb, company, 2], [runs.mar, company, 3], [runs.apr, company, 4], [runs.otherMar, other, 3]] as const) {
    await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,$3,2026,'draft')", [id, co, month]);
    await calculatePayrollRun(id, co);
  }
});

afterAll(async () => {
  vi.useRealTimers();
  try { await cleanPayrollCompanies(pool, [company, other]); } finally { await pool.end(); }
});

describe(`the line flag (TZ=${process.env.TZ ?? 'unset'})`, () => {
  it.each([
    ['PR-STARTS28', 'starts', '2026-03-28', 20000],
    ['PR-ENDS27', 'ends', '2026-03-27', 0],
    ['PR-ENDS30', 'ends', '2026-03-30', 0],
  ])('%s: flagged (%s %s), figures as the read date gives them (gross %d)', async (num, edge, date, gross) => {
    const l = await line(runs.mar, num);
    expect(l.gross).toBe(gross);
    expect(l.flags).toHaveLength(1);
    expect(l.flags[0]!.severity).toBe('error');
    expect(l.flags[0]!.message).toContain('Basic Salary');
    expect(l.flags[0]!.message).toContain(`${edge} on ${date}`);
    expect(l.flags[0]!.message).toContain('needs a manual pro-rata');
    expect(l.flags[0]!.message).toContain(edge === 'starts' ? 'is paid in full' : 'is not paid at all in this run');
    // A row ending in the band is fixed differently from one starting there (Hein, M2 wording).
    expect(l.flags[0]!.message).toContain(edge === 'starts' ? 'start it on the 1st of next month' : 'Assign the days it ran as a once-off');
    expect(l.flags[0]!.message).toContain('Edit dates');
    expect((l.flags[0] as { deepLink?: string }).deepLink).toBe(`/payroll/employees/${ids[num]}#pay-components`);
  });

  it('a row that starts and ends inside the band: both dates, and it is not paid', async () => {
    const l = await line(runs.mar, 'PR-WITHIN');
    expect(l.gross).toBe(0);
    expect(l.flags.map(f => f.message)).toEqual([expect.stringContaining('starts on 2026-03-28 and ends on 2026-03-29')]);
    expect(l.flags[0]!.message).toContain('is not paid');
    expect(l.flags[0]!.message).not.toContain('paid in full');
  });

  it.each(['PR-STARTS27', 'PR-ENDS26', 'PR-ENDS31', 'PR-ONCEOFF30', 'PR-VOIDED', 'W301-1'])('%s: not flagged', async (num) => {
    if (num === 'W301-1') ids[num] = String((await pool.query("SELECT id FROM payroll_employees WHERE company_id=$1 AND employee_number='W301-1'", [company])).rows[0].id);
    expect((await line(runs.mar, num)).flags).toEqual([]);
  });

  it('a row starting on 28 February, the last day of the month: flagged in February, not in March', async () => {
    expect((await line(runs.feb, 'PR-FEB28')).flags.map(f => f.message)).toEqual([expect.stringContaining('starts on 2026-02-28')]);
    expect((await line(runs.mar, 'PR-FEB28')).flags).toEqual([]);
  });
});

describe('the approval gate', () => {
  it('refuses the run, naming each flagged employee, component and date, and no one else', async () => {
    const b = await blockerOf(company, runs.mar);
    expect(b?.code).toBe('recurring_needs_pro_rata');
    for (const s of ['PR-STARTS28 Basic Salary starts on 2026-03-28', 'PR-ENDS27 Basic Salary ends on 2026-03-27', 'PR-ENDS30 Basic Salary ends on 2026-03-30',
      'PR-WITHIN Basic Salary starts on 2026-03-28 and ends on 2026-03-29']) {
      expect(b!.detail).toContain(s);
    }
    for (const s of ['PR-STARTS27', 'PR-ENDS26', 'PR-ENDS31', 'PR-ONCEOFF30', 'PR-VOIDED', 'PR-FEB28', 'W301-1']) expect(b!.detail).not.toContain(s);
    expect((await blockerOf(company, runs.feb))?.detail).toContain('PR-FEB28 Basic Salary starts on 2026-02-28');
  });

  it("the other tenant's run is refused for its own employee only", async () => {
    const b = await blockerOf(other, runs.otherMar);
    expect(b?.detail).toContain('W301-1 Basic Salary ends on 2026-03-29');
    expect(b?.detail).not.toContain('PR-');
  });

  it('a row moved into the band after calculating refuses a run that carries no flag', async () => {
    expect(await blockerOf(company, runs.apr)).toBeNull();
    await pool.query("UPDATE payroll_employee_components SET effective_to='2026-04-28' WHERE employee_id=$1 AND is_recurring", [ids['PR-ONCEOFF30']]);
    expect((await blockerOf(company, runs.apr))?.detail).toContain('PR-ONCEOFF30 Basic Salary ends on 2026-04-28');
  });

  it('changing the dates clears it only once the run is recalculated', async () => {
    // The part month as a once-off, the recurring row from the 1st of next month; the ended rows run to the month end.
    await pool.query("UPDATE payroll_employee_components SET effective_from='2026-04-01' WHERE employee_id=$1", [ids['PR-STARTS28']]);
    await pool.query(
      `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
       VALUES($1,$2,2580.65,'2026-03-28','2026-03-31',false)`, [ids['PR-STARTS28'], bonus]);
    await pool.query("UPDATE payroll_employee_components SET effective_to='2026-03-31' WHERE employee_id=ANY($1::uuid[])", [[ids['PR-ENDS27'], ids['PR-ENDS30']]]);
    await pool.query("UPDATE payroll_employee_components SET effective_to='2026-03-27' WHERE employee_id=$1", [ids['PR-WITHIN']]);
    const stale = await blockerOf(company, runs.mar);
    expect(stale?.code).toBe('recurring_needs_pro_rata');
    expect(stale!.detail).toMatch(/recalculate/i);
    for (const n of ['PR-STARTS28', 'PR-ENDS27', 'PR-ENDS30']) expect(stale!.detail).toContain(n);

    await calculatePayrollRun(runs.mar, company);
    for (const n of ['PR-STARTS28', 'PR-ENDS27', 'PR-ENDS30']) expect((await line(runs.mar, n)).flags).toEqual([]);
    expect((await line(runs.mar, 'PR-STARTS28')).gross).toBe(2580.65);
    expect(await blockerOf(company, runs.mar)).toBeNull();
  });
});
