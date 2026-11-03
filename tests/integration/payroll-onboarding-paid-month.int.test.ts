/**
 * Onboarding a hire (POST /api/payroll/employees with a salary) whose start date falls in a month an approved run
 * already paid. The salary would be dated in that month and never paid for it, so the request is refused with a 400
 * BEFORE the first write (a 4xx commits, so nothing may be written first): no employee row is left behind. The message
 * names the month and the remedy. `salary.effectiveFrom` (not before the start date) puts the salary in an open month.
 * An employee created without a salary writes no assignment, so it is not refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import employees from '../../pages/api/payroll/employees';
import components from '../../pages/api/payroll/employees/[id]/components';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const owner = crypto.randomUUID();
let call: ReturnType<typeof routeCaller>;
let basic = '';

const post = (body: Record<string, unknown>) => call(employees as Route, 'POST', '/api/payroll/employees', undefined, { body });
const hire = (employeeNumber: string, startDate: string, salary?: Record<string, unknown>) => ({
  firstName: 'Late', lastName: 'Hire', employeeNumber, employmentType: 'permanent', startDate,
  ...(salary ? { salary: { componentId: basic, amountCents: 2_000_000, ...salary } } : {}),
});
const rowsOf = async (employeeNumber: string) => (await pool.query<{ id: string }>(
  'SELECT id FROM payroll_employees WHERE company_id = $1 AND employee_number = $2', [company, employeeNumber])).rows;

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Onboarding in a paid month']);
  await seedPayrollCompany(pool, company);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [owner, `${owner}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, owner]);
  const token = await new SignJWT({ sub: owner, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [owner]: token }, { user: owner, company });
  basic = (await pool.query<{ id: string }>("SELECT id FROM payroll_components WHERE company_id = $1 AND sars_source_code = '3601'", [company])).rows[0]!.id;
  const feb = await calculatedRun(call, 2);
  const plan = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${feb}/journal-plan`, feb);
  const done = await call(approve as Route, 'POST', `/api/payroll/runs/${feb}/approve`, feb, { body: { expectedPlanHash: plan.body.data?.planHash } });
  expect(done.statusCode, JSON.stringify(done.body)).toBe(200);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id = $1', [owner]);
  } finally { await pool.end(); }
});

describe('a hire starting in the paid month', () => {
  it('is refused with the month and the remedy, and no employee is written', async () => {
    const out = await post(hire('LH-1', '2026-02-10', {}));
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toBe('February 2026 is already paid. Set the salary to start 2026-03-01 and pay the February days as a once-off in an open month.');
    expect(await rowsOf('LH-1')).toHaveLength(0);
  });

  it('is created when the salary starts in the next open month', async () => {
    const out = await post(hire('LH-2', '2026-02-10', { effectiveFrom: '2026-03-01' }));
    expect(out.statusCode, JSON.stringify(out.body)).toBe(201);
    const id = (await rowsOf('LH-2'))[0]!.id;
    const { rows } = await pool.query("SELECT to_char(effective_from,'YYYY-MM-DD') AS f FROM payroll_employee_components WHERE employee_id=$1", [id]);
    expect(rows).toEqual([{ f: '2026-03-01' }]);
  });

  it('is refused when the salary starts before the start date, or in the paid month again', async () => {
    const before = await post(hire('LH-3', '2026-03-10', { effectiveFrom: '2026-03-01' }));
    expect(before.statusCode).toBe(400);
    expect(before.body.error?.message).toMatch(/effectiveFrom.*not.*before.*startDate/i);
    const paid = await post(hire('LH-4', '2026-02-10', { effectiveFrom: '2026-02-15' }));
    expect(paid.statusCode).toBe(400);
    expect(paid.body.error?.message).toMatch(/February 2026 is already paid/);
    expect(await rowsOf('LH-3')).toHaveLength(0);
    expect(await rowsOf('LH-4')).toHaveLength(0);
  });

  it('without a salary writes no assignment, so it is created', async () => {
    expect((await post(hire('LH-5', '2026-02-10'))).statusCode).toBe(201);
  });
});

describe('a held company lock answers 503, not 500 and not a committed 4xx', () => {
  async function whileLocked(request: () => Promise<{ statusCode: number }>): Promise<number> {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`payroll_approval:${company}`]);
      return (await request()).statusCode;
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  }

  it('onboarding with a salary', async () => {
    expect(await whileLocked(() => post(hire('LH-6', '2026-04-01', {})))).toBe(503);
    expect(await rowsOf('LH-6')).toHaveLength(0);
  }, 20000);

  it('components POST', async () => {
    const id = (await rowsOf('LH-2'))[0]!.id;
    const bonus = crypto.randomUUID();
    await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Lock bonus','3605','earning')", [bonus, company]);
    expect(await whileLocked(() => call(components as Route, 'POST', `/api/payroll/employees/${id}/components`, id,
      { body: { componentId: bonus, amount: 100, effectiveFrom: '2026-04-01' } }))).toBe(503);
  }, 20000);
});
