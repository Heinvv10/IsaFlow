/**
 * Blind review of the leaver exemption (2026-11-02). Hein's ruling covers a leaver whose recurring row ends on their
 * end date INSIDE the 27th-to-month-end band: that month pays in full and is not flagged. Not earlier, and not a row
 * that was superseded or has a live successor of the same component.
 *   1 end date 10 March: the salary is not paid as recurring in March (as master); a hand-entered 1-10 March pro-rata
 *     once-off is paid once. End date 28 March: paid in full.
 *   2 a salary ending on the end date (28 March) but superseded, or followed by a live row from the 29th: paid once.
 *   3 a row starting on the 28th and ending on the end date (30 March) is flagged as starting (paid in full).
 *   4 a once-off back-dated into an approved month is refused also for an employee who was not on that run.
 *   5 Edit dates refuses a row a package superseded.
 *   6 an end date changed after calculation refuses approval until recalculated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';
import components from '../../pages/api/payroll/employees/[id]/components';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import { updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
let call: ReturnType<typeof routeCaller>;
let salary = '';
let bonus = '';
const emp: Record<string, string> = {};
const row: Record<string, string> = {};
let march = '';

async function employee(key: string, start: string, end: string | null) {
  emp[key] = String((await pool.query(
    `INSERT INTO payroll_employees(company_id,employee_number,first_name,last_name,start_date,date_of_birth,tax_number,status,end_date,medical_aid_main_member)
     VALUES($1,$2,'Lea','Ver',$3::date,'1980-01-01','0123456789','active',$4::date,false) RETURNING id`, [company, `LX-${key}`, start, end])).rows[0]!.id);
}
async function add(name: string, key: string, component: string, amount: number, from: string, to: string | null, recurring: boolean, supersededAt: string | null = null) {
  row[name] = String((await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring,supersede_inferred,superseded_at)
     VALUES($1,$2,$3,$4::date,$5::date,$6,FALSE,$7::timestamptz) RETURNING id`, [emp[key], component, amount, from, to, recurring, supersededAt])).rows[0]!.id);
}
async function line(run: string, key: string) {
  const { rows } = await pool.query('SELECT component_breakdown, validation_results FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2', [run, emp[key]]);
  const r = rows[0] as { component_breakdown: Array<{ componentName: string; amount: number }>; validation_results: Array<{ code: string; message: string }> };
  return { paid: r.component_breakdown.filter(c => !c.componentName.includes('(Termination)')).map(c => [c.componentName, Number(c.amount)]).sort(), flags: r.validation_results };
}
const preview = async (run: string) =>
  ((await call(journalPlan as Route, 'GET', `/api/payroll/runs/${run}/journal-plan`, run)).body.data as { blocker: { code: string; detail: string } | null }).blocker;

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Leaver exemption']);
  const seeded = await seedPayrollCompany(pool, company);
  salary = String((await pool.query('SELECT component_id FROM payroll_employee_components WHERE id=$1', [seeded])).rows[0]!.component_id);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, admin]);
  const token = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [admin]: token }, { user: admin, company });
  bonus = crypto.randomUUID();
  await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Pro-rata','3601','earning')", [bonus, company]);

  await employee('end10', '2020-01-01', '2026-03-10');
  await add('end10Salary', 'end10', salary, 21670, '2020-01-01', '2026-03-10', true);
  await add('end10ProRata', 'end10', bonus, 7000, '2026-03-01', '2026-03-10', false);
  await employee('end28', '2020-01-01', '2026-03-28');
  await add('end28Salary', 'end28', salary, 21670, '2020-01-01', '2026-03-28', true);
  await employee('superseded', '2020-01-01', '2026-03-28');
  await add('s1', 'superseded', salary, 21670, '2020-01-01', '2026-03-28', true, '2026-03-01T00:00:00Z');
  await add('s2', 'superseded', salary, 23000, '2026-03-29', null, true);
  await employee('supersededAlone', '2020-01-01', '2026-03-28');
  await add('sa', 'supersededAlone', salary, 21670, '2020-01-01', '2026-03-28', true, '2026-03-01T00:00:00Z');
  await employee('successor', '2020-01-01', '2026-03-28');
  await add('t1', 'successor', salary, 21670, '2020-01-01', '2026-03-28', true);
  await add('t2', 'successor', salary, 23000, '2026-03-29', null, true);
  // Leaving 30 March, with a once-off arrears payment of the same component on the 31st (not a successor).
  await employee('arrears', '2020-01-01', '2026-03-30');
  await add('ar1', 'arrears', salary, 21670, '2020-01-01', '2026-03-30', true);
  await add('ar2', 'arrears', salary, 1500, '2026-03-31', '2026-03-31', false);
  // Leaving 27 March: a package applied on the 28th cut the salary to the 27th, and its replacement was cancelled.
  await employee('voidedReplacement', '2020-01-01', '2026-03-27');
  await add('vr1', 'voidedReplacement', salary, 21670, '2020-01-01', '2026-03-27', true, '2026-03-01T00:00:00Z');
  await add('vr2', 'voidedReplacement', salary, 23000, '2026-03-28', '2026-03-27', true, '2026-03-02T00:00:00Z');
  await employee('startEnd', '2026-03-28', '2026-03-30');
  await add('se', 'startEnd', salary, 21670, '2026-03-28', '2026-03-30', true);
  march = await calculatedRun(call, 3);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

describe(`1-3: the leaver exemption is the band only (TZ=${process.env.TZ ?? 'unset'})`, () => {
  it('end 10 March: the salary is not paid as recurring; the hand-entered 1-10 pro-rata is paid once', async () => {
    expect((await line(march, 'end10')).paid).toEqual([['Pro-rata', 7000]]);
  });

  it('end 28 March: paid in full, not flagged', async () => {
    const l = await line(march, 'end28');
    expect(l.paid).toEqual([['Basic Salary', 21670]]);
    expect(l.flags.map(f => f.code)).not.toContain('RECURRING_NEEDS_PRO_RATA');
  });

  // Every recurring row ending in the band is either paid by the leaver rule or flagged as ending: never neither.
  const flaggedEnding = (l: Awaited<ReturnType<typeof line>>, date: string) =>
    l.flags.some(f => f.code === 'RECURRING_NEEDS_PRO_RATA' && f.message.includes(`ends on ${date}`));

  it('ending on the end date but followed by a live recurring row: one salary, and the skipped row is flagged', async () => {
    const superseded = await line(march, 'superseded');
    expect(superseded.paid).toEqual([['Basic Salary', 23000]]);
    expect(flaggedEnding(superseded, '2026-03-28')).toBe(true);
    // A superseded row cannot be edited (Edit dates refuses it): the flag says to use End.
    expect(superseded.flags.find(f => f.code === 'RECURRING_NEEDS_PRO_RATA')?.message).toMatch(/\bEnd\b/);
    expect(superseded.flags.find(f => f.code === 'RECURRING_NEEDS_PRO_RATA')?.message).not.toMatch(/Edit dates/);
    const successor = await line(march, 'successor');
    expect(successor.paid).toEqual([['Basic Salary', 23000]]);
    expect(flaggedEnding(successor, '2026-03-28')).toBe(true);
  });

  it('a once-off on the 31st is not a successor: the 30 March leaver is paid in full plus the arrears, not flagged', async () => {
    const l = await line(march, 'arrears');
    expect(l.paid).toEqual([['Basic Salary', 1500], ['Basic Salary', 21670]]);
    expect(flaggedEnding(l, '2026-03-30')).toBe(false);
  });

  it('a replacement that was cancelled is not a successor: the 27 March leaver is paid in full, not flagged', async () => {
    const l = await line(march, 'voidedReplacement');
    expect(l.paid).toEqual([['Basic Salary', 21670]]);
    expect(flaggedEnding(l, '2026-03-27')).toBe(false);
  });

  it('a superseded row ending on the end date with nothing live after it is paid by the leaver rule, not flagged', async () => {
    const l = await line(march, 'supersededAlone');
    expect(l.paid).toEqual([['Basic Salary', 21670]]);
    expect(flaggedEnding(l, '2026-03-28')).toBe(false);
  });

  it('starting on the 28th and ending on the end date: flagged as starting, paid in full', async () => {
    const l = await line(march, 'startEnd');
    expect(l.paid).toEqual([['Basic Salary', 21670]]);
    expect(l.flags.find(f => f.code === 'RECURRING_NEEDS_PRO_RATA')?.message).toMatch(/starts on 2026-03-28: this recurring component is paid in full/);
  });
});

describe('4-6', () => {
  it('6: an end date changed after calculation refuses approval until recalculated', async () => {
    await updatePayrollEmployee(emp.end28!, company, { endDate: new Date('2026-03-27') });
    const refused = await preview(march);
    expect(refused?.code).toBe('components_changed_after_calculation');
    expect(refused?.detail).toContain('LX-end28');
  });

  it('4: a once-off back-dated into an approved month is refused for an employee who was not on that run', async () => {
    const april = await calculatedRun(call, 4);
    const plan = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${april}/journal-plan`, april);
    const ok = await call(approve as Route, 'POST', `/api/payroll/runs/${april}/approve`, april, { body: { expectedPlanHash: plan.body.data?.planHash } });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    await employee('lateHire', '2026-06-01', null);
    const out = await call(components as Route, 'POST', `/api/payroll/employees/${emp.lateHire}/components`, emp.lateHire,
      { body: { componentId: bonus, amount: 100, effectiveFrom: '2026-04-10', isRecurring: false } });
    expect(out.statusCode).toBe(400);
    expect(out.body.error?.message).toMatch(/2026-04 .*already paid/);
  });

  it('5: Edit dates refuses a row a package superseded', async () => {
    const out = await call(components as Route, 'PATCH', `/api/payroll/employees/${emp.superseded}/components?aid=${row.s1}`, emp.superseded,
      { body: { effectiveFrom: '2020-01-01', effectiveTo: '2026-03-27' }, query: { aid: row.s1! } });
    expect(out.statusCode).toBe(400);
    expect(out.body.error?.message).toMatch(/replaced/i);
  });
});

describe('1: the paid-month rule uses the band too', () => {
  it('March paid: ending the 10-March leaver\'s salary a day earlier changes nothing March read, so it is allowed', async () => {
    // As an approved March leaves it (the pro-rata flags above keep this fixture's run from approving through the gate).
    await pool.query("UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1", [march]);
    const out = await call(components as Route, 'DELETE', `/api/payroll/employees/${emp.end10}/components?aid=${row.end10Salary}`, emp.end10,
      { body: { effectiveTo: '2026-03-09' }, query: { aid: row.end10Salary! } });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
  });
});
