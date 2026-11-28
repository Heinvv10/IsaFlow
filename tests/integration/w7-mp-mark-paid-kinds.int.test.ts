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
const [TY, TM] = TODAY.split('-').map(Number) as [number, number];
/** The month after today's (Y, M) and the one after that (Y2, M2): every off-cycle pay date below is in the future, always. */
const after = (y: number, m: number): [number, number] => (m === 12 ? [y + 1, 1] : [y, m + 1]);
const [Y, M] = after(TY, TM);
const [Y2, M2] = after(Y, M);
const day = (d: number) => `${Y}-${String(M).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
let employee = '';
let bonusComponent = '';

const mark = (r: R, runId: string, body: unknown) => r.call(markPaid as Route, 'POST', `/api/payroll/runs/${runId}/mark-paid`, runId, { body });
const typed = { reference: 'EFT KINDS 1', paidOn: TODAY };
const createBonus = (amount: number, runDate: string) => c.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, {
  body: { month: M, year: Y, runDate, reason: 'bonus', employees: [{ employeeId: employee, componentId: bonusComponent, amount }] },
});
const snapshot = async (id: string) => (await c.pool.query(
  `SELECT status, approved_at, off_cycle_paid_gross, off_cycle_payday_at, approval_history::text AS history
     FROM payroll_run_headers WHERE id = $1`, [id])).rows[0]!;

/** A calculated client header (no lines, no journal): what a bounce through Demo starts from. A fixed past period, nothing costed. */
const calculatedHeader = async (month: number) => String((await c.pool.query(
  `INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, pay_frequency, period_start, period_end)
   VALUES ($1, 2025, $2, 'calculated', 'monthly', make_date(2025, $2, 1), (make_date(2025, $2, 1) + interval '1 month - 1 day')::date)
   RETURNING id`, [c.company, month])).rows[0]!.id);

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
    const made = await createBonus(5_000, day(1));
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

  it('a correction off-cycle run for the same employee can still be created (paid after the first, before the month closes)', async () => {
    const correction = await createBonus(1_000, day(2));
    expect(correction.statusCode, JSON.stringify(correction.body)).toBe(201);
  }, 120_000);

  it('Q4: a paid run refuses approve, calculate and a salary bank file', async () => {
    await enable(c);
    expect((await mark(c, regular, typed)).statusCode).toBe(200);
    const before = await snapshot(regular);
    const approve = await c.api.approveOnly(regular);
    expect([approve.statusCode, approve.body.error?.code, approve.body.error?.message])
      .toEqual([400, 'BAD_REQUEST', expect.stringMatching(/Cannot approve payroll run with status 'paid'/)]);
    const calculate = await c.api.calculate(regular);
    expect([calculate.statusCode, calculate.body.error?.code, calculate.body.error?.details?.lockedStatus]).toEqual([400, 'BAD_REQUEST', 'paid']);
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
    const run = await c.calculatedRun(M2, Y2);
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

  it('D3: a dual-member app_user cannot bounce a client run through Demo to mark it paid (move in + paid, then back)', async () => {
    const DEMO = '00000000-0000-0000-0000-000000000001';
    const run = await calculatedHeader(6);
    const made = (await c.pool.query("INSERT INTO companies (id, name) VALUES ($1, 'ISAFlow Demo (fixture)') ON CONFLICT (id) DO NOTHING RETURNING id", [DEMO])).rowCount === 1;
    await c.pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [DEMO, c.admin]);
    try {
      const cl = new Client({ connectionString: process.env.DATABASE_URL });
      await cl.connect();
      const attempt = async () => {
        await cl.query('BEGIN');
        await cl.query('SET LOCAL ROLE app_user');
        await cl.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: c.admin, role: 'authenticated' })]);
        await cl.query("SELECT set_config('app.current_company_id', $1, true)", [DEMO]);
        await cl.query("UPDATE payroll_run_headers SET company_id = $2, status = 'paid' WHERE id = $1", [run, DEMO]);
        await cl.query("SELECT set_config('app.current_company_id', $1, true)", [c.company]);
        await cl.query('UPDATE payroll_run_headers SET company_id = $2 WHERE id = $1', [run, c.company]);
        await cl.query('COMMIT');
      };
      try {
        // The company-fixed trigger (review #1911 MEDIUM) now refuses the move first; the D3 rule refused the paid step
        // before it existed (mutation proof at 821e81a88a). Either way nothing is written.
        await expect(attempt()).rejects.toThrow(/company is fixed|only with its payroll journal in force/);
      } finally {
        await cl.query('ROLLBACK').catch(() => undefined);
        await cl.end();
      }
      expect((await c.pool.query('SELECT company_id, status FROM payroll_run_headers WHERE id = $1', [run])).rows[0])
        .toEqual({ company_id: c.company, status: 'calculated' });
    } finally {
      await c.pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [DEMO, c.admin]);
      if (made) await c.pool.query('DELETE FROM companies WHERE id = $1', [DEMO]);
    }
  }, 120_000);

  it('three-step bounce: move a calculated client run into Demo, mark it paid there, move it back: step 1 is refused', async () => {
    const DEMO = '00000000-0000-0000-0000-000000000001';
    const run = await calculatedHeader(7);
    const made = (await c.pool.query("INSERT INTO companies (id, name) VALUES ($1, 'ISAFlow Demo (fixture)') ON CONFLICT (id) DO NOTHING RETURNING id", [DEMO])).rowCount === 1;
    await c.pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [DEMO, c.admin]);
    const cl = new Client({ connectionString: process.env.DATABASE_URL });
    await cl.connect();
    const as = (co: string) => cl.query("SELECT set_config('app.current_company_id', $1, true)", [co]);
    try {
      const bounce = async () => {
        await cl.query('BEGIN');
        await cl.query('SET LOCAL ROLE app_user');
        await cl.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: c.admin, role: 'authenticated' })]);
        await as(DEMO);
        await cl.query('UPDATE payroll_run_headers SET company_id = $2 WHERE id = $1', [run, DEMO]); // 1: into Demo
        await cl.query("UPDATE payroll_run_headers SET status = 'paid' WHERE id = $1", [run]); // 2: paid, as Demo's
        await as(c.company);
        await cl.query('UPDATE payroll_run_headers SET company_id = $2 WHERE id = $1', [run, c.company]); // 3: back
        await cl.query('COMMIT');
      };
      await expect(bounce()).rejects.toThrow(/a pay run's company is fixed/);
    } finally {
      await cl.query('ROLLBACK').catch(() => undefined);
      await cl.end();
      await c.pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [DEMO, c.admin]);
      if (made) await c.pool.query('DELETE FROM companies WHERE id = $1', [DEMO]).catch(() => undefined);
    }
    expect((await c.pool.query('SELECT company_id, status FROM payroll_run_headers WHERE id = $1', [run])).rows[0])
      .toEqual({ company_id: c.company, status: 'calculated' });
  }, 120_000);

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
