/**
 * Wave 7 MP, review #1911 fixes (real routes, withAuth, app_user, RLS; disposable fixture):
 *  - Q1: an OFF-CYCLE run is marked paid, and approved -> paid is not a reopen: 999x's off_cycle_paid_gross snapshot,
 *    approved_at and payday stay as they were (1053 replaces that trigger function); its reopen is 409 RUN_PAID naming
 *    a new off-cycle run, and that correction run can still be created. A WEEKLY run is marked paid too.
 *  - Q4: a paid run refuses approve, calculate and a salary bank file.
 *  - B4/B5: below the service, as app_user, a paid run does not leave paid, and an approved run does not become paid
 *    without paid_on or with its journal reversed; the Demo reseed's reopen and re-finalise still work as a
 *    NOSUPERUSER table owner (as production's postgres), in a transaction rolled back after.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import markPaid from '../../pages/api/payroll/runs/[id]/mark-paid';
import offCycle from '../../pages/api/payroll/runs/off-cycle';
import runs from '../../pages/api/payroll/runs';
import payFrequency from '../../pages/api/payroll/employees/[id]/pay-frequency';
import { todayInSast } from '@/lib/saDateParser';
import { finaliseRuns, reopenFinalRuns } from '../../scripts/lib/demoReseed/payrollFinal';
import { txOver } from '../../scripts/lib/demoReseed/db';
import { rig, type Route } from './brkr.helpers';
import { cleanup, enable, generate, reason, type R } from './payroll-bank-file.helpers';

let c: R;
let w: R;
const TODAY = todayInSast();
const [Y, M] = TODAY.split('-').map(Number) as [number, number];
let employee = '';
let bonusComponent = '';

const mark = (r: R, runId: string, body: unknown) => r.call(markPaid as Route, 'POST', `/api/payroll/runs/${runId}/mark-paid`, runId, { body });
const typed = { reference: 'EFT KINDS 1', paidOn: TODAY };
const createBonus = (amount: number) => c.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, {
  body: { month: M, year: Y, runDate: TODAY, reason: 'bonus', employees: [{ employeeId: employee, componentId: bonusComponent, amount }] },
});
const snapshot = async (id: string) => (await c.pool.query(
  `SELECT status, approved_at, off_cycle_paid_gross, off_cycle_payday_at, approval_history::text AS history
     FROM payroll_run_headers WHERE id = $1`, [id])).rows[0]!;

/** As app_user under the tenant's RLS with a session user, as withAuth sets it; rolled back on error. */
async function asAppUser(r: R, text: string, values: unknown[]): Promise<void> {
  const cl = new Client({ connectionString: process.env.DATABASE_URL });
  await cl.connect();
  try {
    await cl.query('BEGIN');
    await cl.query('SET LOCAL ROLE app_user');
    await cl.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: r.admin, role: 'authenticated' })]);
    await cl.query("SELECT set_config('app.current_company_id', $1, true)", [r.company]);
    await cl.query(text, values);
    await cl.query('COMMIT');
  } catch (err) {
    await cl.query('ROLLBACK');
    throw err;
  } finally { await cl.end(); }
}

beforeAll(async () => {
  c = await rig('w7-mp-kinds-c');
  w = await rig('w7-mp-kinds-w');
  await c.setup();
  await w.setup();
  employee = (await c.employee(30_000)).employee;
  bonusComponent = (await c.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
    VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [c.company])).rows[0].id;
}, 240_000);
afterAll(async () => {
  if (c) {
    await c.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [c.company]).catch(() => undefined);
    await cleanup(c);
  }
  if (w) await w.teardown();
}, 120_000);

describe('Q1: an off-cycle run is marked paid; approved -> paid is not a reopen', () => {
  let regular = '';
  let bonus = '';
  it('marks paid with its snapshot, approval time and payday unchanged; reopen is 409 naming a new off-cycle run', async () => {
    regular = await c.calculatedRun(M, Y);
    expect((await c.api.approve(regular)).statusCode).toBe(200);
    const made = await createBonus(5_000);
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    bonus = String(made.body.data!.id);
    expect((await c.api.calculate(bonus)).statusCode).toBe(200);
    const ap = await c.api.approve(bonus);
    expect(ap.statusCode, JSON.stringify(ap.body)).toBe(200);
    const before = await snapshot(bonus);
    const res = await mark(c, bonus, typed);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const after = await snapshot(bonus);
    expect(after.status).toBe('paid');
    expect({ ...after, status: before.status }).toEqual(before);

    const reopened = await c.api.reopen(bonus);
    expect(reopened.statusCode).toBe(409);
    expect(reopened.body.error.details.code).toBe('RUN_PAID');
    expect(reopened.body.error.message).toMatch(/new off-cycle run of its month/);
    expect(await snapshot(bonus)).toEqual(after);
  }, 240_000);

  // A new off-cycle run is paid after the last one (creation order is pay order) and before the regular run's pay date (the
  // month's last day): the day before it, when that is still after today.
  const payDate = new Date(Date.UTC(Y, M, 0) - 86_400_000).toISOString().slice(0, 10);
  it.skipIf(payDate <= TODAY)('a correction off-cycle run for the same employee can still be created', async () => {
    const correction = await c.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, {
      body: { month: M, year: Y, runDate: payDate, reason: 'bonus', employees: [{ employeeId: employee, componentId: bonusComponent, amount: 1_000 }] },
    });
    expect(correction.statusCode, JSON.stringify(correction.body)).toBe(201);
  }, 120_000);

  it('Q4: a paid run refuses approve, calculate and a salary bank file', async () => {
    await enable(c);
    expect((await mark(c, regular, typed)).statusCode).toBe(200);
    const before = await snapshot(regular);
    expect((await c.api.approveOnly(regular)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await c.api.calculate(regular)).statusCode).toBeGreaterThanOrEqual(400);
    const file = await generate(c, regular, { actionDate: TODAY });
    expect([file.statusCode, reason(file)]).toEqual([409, 'BANK_HAS_PAID']);
    expect(await snapshot(regular)).toEqual(before);
  }, 120_000);

  it('B4: below the service, app_user cannot take a paid run out of paid', async () => {
    await expect(asAppUser(c, "UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1", [regular]))
      .rejects.toThrow(/a paid run stays paid/);
    expect((await snapshot(regular)).status).toBe('paid');
  });
});

describe('a weekly run is marked paid', () => {
  it('weekly: approve, then a typed reference marks it paid', async () => {
    const { employee: weekly } = await w.employee(1_000);
    expect((await w.call(payFrequency as Route, 'PUT', `/api/payroll/employees/${weekly}/pay-frequency`, weekly,
      { body: { payFrequency: 'weekly' } })).statusCode).toBe(200);
    const d = new Date(`${TODAY}T00:00:00Z`);
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
    const made = await w.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { body: { frequency: 'weekly', periodStart: monday } });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const run = String(made.body.data!.id);
    expect((await w.api.calculate(run)).statusCode).toBe(200);
    const ap = await w.api.approve(run);
    expect(ap.statusCode, JSON.stringify(ap.body)).toBe(200);
    const res = await mark(w, run, { reference: 'EFT WEEKLY 1', paidOn: TODAY });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect((await w.pool.query('SELECT status, pay_frequency FROM payroll_run_headers WHERE id = $1', [run])).rows[0])
      .toEqual({ status: 'paid', pay_frequency: 'weekly' });
  }, 240_000);
});

describe('B5 below the service, and the Demo reseed as a NOSUPERUSER owner', () => {
  it('app_user cannot mark a run paid without paid_on, or with its journal reversed', async () => {
    const run = await c.calculatedRun(1, 2027);
    expect((await c.api.approve(run)).statusCode).toBe(200);
    await expect(asAppUser(c, "UPDATE payroll_run_headers SET status = 'paid' WHERE id = $1", [run]))
      .rejects.toThrow(/only with its payment date/);
    const journal = String((await c.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [run])).rows[0]!.journal_entry_id);
    expect((await c.api.reopen(run)).statusCode).toBe(200);
    expect((await c.api.reverse(journal)).statusCode).toBe(200);
    await c.pool.query("UPDATE payroll_run_headers SET status = 'approved', approved_at = clock_timestamp() WHERE id = $1", [run]);
    await expect(asAppUser(c, "UPDATE payroll_run_headers SET status = 'paid', paid_on = current_date WHERE id = $1", [run]))
      .rejects.toThrow(/only with its payroll journal in force/);
    expect((await c.pool.query('SELECT status FROM payroll_run_headers WHERE id = $1', [run])).rows[0]!.status).toBe('approved');
  }, 240_000);

  it('the reseed reopens and re-finalises a paid run as a NOSUPERUSER owner of payroll_run_headers (rolled back)', async () => {
    const paid = String((await w.pool.query("SELECT id, approved_at FROM payroll_run_headers WHERE company_id = $1 AND status = 'paid'", [w.company])).rows[0]!.id);
    const cl = new Client({ connectionString: process.env.DATABASE_URL });
    await cl.connect();
    try {
      await cl.query('BEGIN');
      // Production's shape: postgres is NOSUPERUSER, BYPASSRLS, in migration_admin and app_user, and OWNS the table.
      await cl.query('CREATE ROLE w7_mp_reseed_owner NOSUPERUSER BYPASSRLS NOLOGIN IN ROLE migration_admin, app_user');
      await cl.query('ALTER TABLE public.payroll_run_headers OWNER TO w7_mp_reseed_owner');
      await cl.query('SET LOCAL ROLE w7_mp_reseed_owner');
      expect((await cl.query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")).rows[0]!.rolsuper).toBe(false);
      const tx = txOver(cl);
      const approvedAt = (await cl.query('SELECT approved_at FROM payroll_run_headers WHERE id = $1', [paid])).rows[0]!.approved_at;
      expect(await reopenFinalRuns(tx, w.company)).toBeGreaterThanOrEqual(1);
      expect((await cl.query('SELECT status, paid_at, paid_on FROM payroll_run_headers WHERE id = $1', [paid])).rows[0])
        .toEqual({ status: 'calculated', paid_at: null, paid_on: null });
      await finaliseRuns(tx, w.company, [{ id: paid, status: 'paid', approved_at: approvedAt, approval_grandfathered_at: null }]);
      expect((await cl.query('SELECT status, paid_at IS NOT NULL AS stamped FROM payroll_run_headers WHERE id = $1', [paid])).rows[0])
        .toEqual({ status: 'paid', stamped: true });
    } finally {
      await cl.query('ROLLBACK');
      await cl.end();
    }
    expect((await w.pool.query('SELECT status FROM payroll_run_headers WHERE id = $1', [paid])).rows[0]!.status).toBe('paid');
  }, 120_000);
});
