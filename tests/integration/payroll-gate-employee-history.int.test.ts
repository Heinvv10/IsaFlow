/**
 * Blind review of 258b40ac3 (2026-11-02): what the approval gate reads from the employee change history (888).
 *   2  a termination detail changed after calculation (reason, notice, served notice, severance weeks, leave pay-out)
 *      refuses approval until recalculated: adding a retrenchment reason.
 *   3  updatePayrollEmployee (end date) and setTerminationDetails wait for the company's payroll-approval lock.
 *   5  an end-date change counts only when the old or the new date is on or before the run's last day, or empty.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import employeeRoute from '../../pages/api/payroll/employees/[id]';
import { updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { setTerminationDetails } from '@/modules/accounting/services/payroll/payrollTerminationService';
import { payrollTermsChangedSinceCalculation } from '@/modules/accounting/services/core/entityChanges/entityChangeQuery';
import { als } from '@/lib/als';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
let call: ReturnType<typeof routeCaller>;
let leaver = '';
let future = '';
let open = '';

const preview = async (run: string) =>
  ((await call(journalPlan as Route, 'GET', `/api/payroll/runs/${run}/journal-plan`, run)).body.data as { blocker: { code: string; detail: string } | null }).blocker;
async function employee(num: string, end: string | null): Promise<string> {
  const salary = String((await pool.query("SELECT id FROM payroll_components WHERE company_id=$1 AND sars_source_code='3601'", [company])).rows[0]!.id);
  const id = String((await pool.query(
    `INSERT INTO payroll_employees(company_id,employee_number,first_name,last_name,start_date,date_of_birth,tax_number,status,end_date,medical_aid_main_member)
     VALUES($1,$2,'His','Tory','2020-01-01','1980-01-01','0123456789','active',$3::date,false) RETURNING id`, [company, num, end])).rows[0]!.id);
  await pool.query(
    "INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,supersede_inferred) VALUES($1,$2,20000,'2020-01-01',FALSE)", [id, salary]);
  return id;
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Gate employee history']);
  await seedPayrollCompany(pool, company);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, admin]);
  const token = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [admin]: token }, { user: admin, company });
  leaver = await employee('GH-LEAVER', '2026-03-15');
  future = await employee('GH-FUTURE', '2027-06-30');
  open = await employee('GH-OPEN', null);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

describe(`the gate reads termination and end-date changes (TZ=${process.env.TZ ?? 'unset'})`, () => {
  it('5: an end date moved from June to July 2027 does not touch the April run', async () => {
    const april = await calculatedRun(call, 4);
    expect(await preview(april)).toBeNull();
    await updatePayrollEmployee(future, company, { endDate: new Date('2027-07-31') });
    expect(await preview(april)).toBeNull();
  });

  it('2 (L): an empty end date set to 31 May 2026 does not touch the February run (empty = no end)', async () => {
    const feb = await calculatedRun(call, 2);
    expect(await preview(feb)).toBeNull();
    await updatePayrollEmployee(open, company, { endDate: new Date('2026-05-31') });
    expect(await preview(feb)).toBeNull();
  });

  it('2: a retrenchment reason added after calculation refuses approval until recalculated', async () => {
    const run = await calculatedRun(call, 3);
    expect(await preview(run)).toBeNull();
    await setTerminationDetails(company, leaver, {
      reason: 'retrenchment', noticePeriodDays: 30, servedNoticeDays: 30, severanceWeeksPerYear: 1, includeLeavePayout: false,
    });
    const refused = await preview(run);
    expect(refused?.code).toBe('components_changed_after_calculation');
    expect(refused?.detail).toContain('GH-LEAVER');
  });
});

describe('3: end-date and termination writers wait for the company lock', () => {
  async function waitsForLock(write: () => Promise<unknown>): Promise<void> {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`payroll_approval:${company}`]);
      let done = false;
      const pending = write().then(() => { done = true; });
      await new Promise(r => setTimeout(r, 700));
      expect(done, 'the write did not wait for the lock').toBe(false);
      await holder.query('COMMIT');
      await pending;
      expect(done).toBe(true);
    } finally { holder.release(); }
  }

  it('updatePayrollEmployee with an end date', async () => {
    await waitsForLock(() => updatePayrollEmployee(future, company, { endDate: new Date('2027-08-31') }));
  });

  it('setTerminationDetails', async () => {
    await waitsForLock(() => setTerminationDetails(company, future, {
      reason: 'resignation', noticePeriodDays: 30, servedNoticeDays: 30, severanceWeeksPerYear: null, includeLeavePayout: false,
    }));
  });
});

describe('3 (L): a role that may not read the history gets null (the gate then refuses), not an error or "no change"', () => {
  async function asRole(role: string, session?: { activeCompany: string }, scope?: { runId: string; ids: string[] }): Promise<string[] | null> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (session) {
        // As withAuth sets them: the user's claims and the request's company.
        await c.query("SELECT set_config('request.jwt.claims', $1, true), set_config('app.current_company_id', $2, true)",
          [JSON.stringify({ sub: admin }), session.activeCompany]);
      }
      await c.query(`SET LOCAL ROLE ${role}`);
      const run = scope?.runId ?? crypto.randomUUID();
      return await als.run({ client: c, userId: admin, companyId: company, claims: {} } as never,
        () => payrollTermsChangedSinceCalculation(company, run, scope?.ids ?? [leaver]));
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  it('migration_admin: bypasses RLS but holds no privilege on entity_changes', async () => {
    expect(await asRole('migration_admin')).toBeNull();
  });

  it('app_user with no company member role (no session claims)', async () => {
    expect(await asRole('app_user')).toBeNull();
  });

  it('app_user as the owner: a leaver whose end date was changed (through the route) after calculation is named; '
    + 'in a request for another company, null', async () => {
    const julyLeaver = await employee('GH-JULY', '2026-07-15');
    const july = await calculatedRun(call, 7);
    const changed = await call(employeeRoute as Route, 'PATCH', `/api/payroll/employees/${julyLeaver}`, julyLeaver,
      { body: { endDate: '2026-07-20' } });
    expect(changed.statusCode, JSON.stringify(changed.body)).toBe(200);
    expect(await asRole('app_user', { activeCompany: company }, { runId: july, ids: [julyLeaver, open] })).toEqual([julyLeaver]);
    expect(await asRole('app_user', { activeCompany: crypto.randomUUID() }, { runId: july, ids: [julyLeaver] })).toBeNull();
  });

  it('a role outside app_user (column privileges, owner claims, this company, no RLS bypass): null', async () => {
    const role = `gh_reader_${Math.floor(Math.random() * 1e9)}`;
    await pool.query(`CREATE ROLE ${role} NOLOGIN`);
    try {
      await pool.query(`GRANT ${role} TO current_user`);
      await pool.query(`GRANT SELECT (company_id, entity_type, entity_id, changed, before, after, recorded_at) ON entity_changes TO ${role}`);
      await pool.query(`GRANT SELECT ON payroll_run_headers TO ${role}`);
      await pool.query(`GRANT USAGE ON SCHEMA app, auth TO ${role}`);
      expect(await asRole(role, { activeCompany: company })).toBeNull();
    } finally {
      await pool.query(`REVOKE ALL ON entity_changes FROM ${role}`).catch(() => undefined);
      await pool.query(`REVOKE ALL ON payroll_run_headers FROM ${role}`).catch(() => undefined);
      await pool.query(`REVOKE USAGE ON SCHEMA app, auth FROM ${role}`).catch(() => undefined);
      await pool.query(`DROP ROLE ${role}`).catch(() => undefined);
    }
  });
});
