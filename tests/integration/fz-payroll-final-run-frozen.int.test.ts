/**
 * Wave 6 FZ (migration 999n): a FINAL pay run's figures are frozen in the database.
 * Final = R-035's isPayRunFinal: status approved or paid with approved_at or approval_grandfathered_at.
 * Folds in the PR #1524 breaker repros BRK-3 and D-1 as refusals (IsaFlow-rev1524-repros).
 * Each forgery runs as app_user under the tenant's RLS and claims (what withAuth sets), and the key
 * ones again as `postgres` (BYPASSRLS on production; a superuser here). The app's own writes on a
 * final run (approval, payslip snapshot, re-approval, reopen) run through the real routes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { rig } from './brkr.helpers';

let a: Awaited<ReturnType<typeof rig>>;
let b: Awaited<ReturnType<typeof rig>>;
const emp: string[] = [];
const FROZEN = /final pay run/;

/** One transaction as app_user under this tenant's RLS and claims. */
async function asAppUser(company: string, sub: string, fn: (c: PoolClient) => Promise<unknown>): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub, role: 'authenticated' })]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    await fn(c);
    await c.query('COMMIT');
  } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); await pool.end(); }
}
const app = (fn: (c: PoolClient) => Promise<unknown>) => asAppUser(a.company, a.admin, fn);

async function approvedRun(month: number): Promise<string> {
  const id = await a.calculatedRun(month);
  const ap = await a.api.approve(id);
  if (ap.statusCode !== 200) throw new Error(`approve ${month}: ${ap.statusCode} ${JSON.stringify(ap.body)}`);
  return id;
}
const lineNet = async (run: string, e: string) => Number((await a.pool.query(
  'SELECT net_pay FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [run, e])).rows[0]!.net_pay);

let run1 = '';

beforeAll(async () => {
  a = await rig('fz-a');
  b = await rig('fz-b');
  await a.setup();
  await b.setup();
  emp.push((await a.employee(25000)).employee, (await a.employee(18000)).employee);
  await b.employee(250000);
  run1 = await approvedRun(1);
}, 240_000);
afterAll(async () => { await a.teardown(); await b.teardown(); });

describe('FZ: a final run refuses money changes the app never makes', () => {
  it('BRK-3: app_user cannot move one employee\'s net pay on an approved run', async () => {
    const before = await lineNet(run1, emp[0]!);
    await expect(app((c) => c.query('UPDATE payroll_run_lines SET net_pay = net_pay + 50000 WHERE run_id = $1 AND employee_id = $2', [run1, emp[0]])))
      .rejects.toThrow(FROZEN);
    expect(await lineNet(run1, emp[0]!)).toBe(before);
  }, 60_000);

  it('BRK-3b: nor redistribute net pay between employees at the same total, nor touch PAYE or the breakdown', async () => {
    await expect(app(async (c) => {
      await c.query('UPDATE payroll_run_lines SET net_pay = net_pay + 1000 WHERE run_id = $1 AND employee_id = $2', [run1, emp[0]]);
      await c.query('UPDATE payroll_run_lines SET net_pay = net_pay - 1000 WHERE run_id = $1 AND employee_id = $2', [run1, emp[1]]);
    })).rejects.toThrow(FROZEN);
    await expect(app((c) => c.query('UPDATE payroll_run_lines SET paye = 0 WHERE run_id = $1', [run1]))).rejects.toThrow(FROZEN);
    await expect(app((c) => c.query("UPDATE payroll_run_lines SET component_breakdown = '[]'::jsonb WHERE run_id = $1", [run1]))).rejects.toThrow(FROZEN);
  }, 60_000);

  it('D-1: app_user cannot move the header total and drop the journal link', async () => {
    const before = await a.header(run1);
    await expect(app((c) => c.query('UPDATE payroll_run_headers SET total_net = total_net + 50000, journal_entry_id = NULL WHERE id = $1', [run1])))
      .rejects.toThrow(FROZEN);
    await expect(app((c) => c.query('UPDATE payroll_run_headers SET total_net = total_net + 50000 WHERE id = $1', [run1]))).rejects.toThrow(FROZEN);
    await expect(app((c) => c.query('UPDATE payroll_run_headers SET journal_entry_id = NULL WHERE id = $1', [run1]))).rejects.toThrow(FROZEN);
    expect(await a.header(run1)).toEqual(before);
  }, 60_000);

  it('the journal link cannot be swapped for another posted journal', async () => {
    const other = (await a.pool.query(
      `INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
       VALUES ($1, '2026-01-25', 'Payroll run 2026-01', 'auto_payroll', 'posted', $2) RETURNING id`, [a.company, a.admin])).rows[0]!.id;
    await expect(app((c) => c.query('UPDATE payroll_run_headers SET journal_entry_id = $2 WHERE id = $1', [run1, other]))).rejects.toThrow(FROZEN);
  }, 60_000);

  it('approval stamps cannot be cleared while the run stays approved (the freeze would lapse)', async () => {
    await expect(app((c) => c.query('UPDATE payroll_run_headers SET approved_at = NULL WHERE id = $1', [run1]))).rejects.toThrow(FROZEN);
    await expect(app((c) => c.query('UPDATE payroll_run_headers SET approved_at = approved_at - interval \'1 day\' WHERE id = $1', [run1]))).rejects.toThrow(FROZEN);
  }, 60_000);

  it('no line is inserted into, deleted from or moved into a final run', async () => {
    await expect(app((c) => c.query('DELETE FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [run1, emp[1]]))).rejects.toThrow(FROZEN);
    const draft = String((await a.api.createRun(5)).body.data!.id);
    expect((await a.api.calculate(draft)).statusCode).toBe(200);
    await expect(app((c) => c.query('UPDATE payroll_run_lines SET run_id = $1 WHERE run_id = $2 AND employee_id = $3', [run1, draft, emp[0]])))
      .rejects.toThrow(FROZEN);
    await expect(app((c) => c.query('INSERT INTO payroll_run_lines (run_id, employee_id, net_pay) VALUES ($1, $2, 1)', [run1, emp[0]])))
      .rejects.toThrow(FROZEN);
    // The draft run's own lines stay writable: only a final run is frozen.
    await app((c) => c.query('UPDATE payroll_run_lines SET net_pay = net_pay WHERE run_id = $1', [draft]));
  }, 120_000);

  it('a role that bypasses RLS is refused too (the freeze is a state rule, not a role rule)', async () => {
    await expect(a.pool.query('UPDATE payroll_run_lines SET net_pay = net_pay + 1 WHERE run_id = $1', [run1])).rejects.toThrow(FROZEN);
    await expect(a.pool.query('UPDATE payroll_run_headers SET total_gross = 0 WHERE id = $1', [run1])).rejects.toThrow(FROZEN);
  }, 60_000);

  it('a paid run is frozen as an approved one is; approved -> paid itself is allowed', async () => {
    const run = await approvedRun(2);
    await app((c) => c.query("UPDATE payroll_run_headers SET status = 'paid', paid_at = now() WHERE id = $1", [run]));
    await expect(app((c) => c.query('UPDATE payroll_run_lines SET net_pay = 0 WHERE run_id = $1', [run]))).rejects.toThrow(FROZEN);
    await expect(app((c) => c.query('UPDATE payroll_run_headers SET total_net = 0 WHERE id = $1', [run]))).rejects.toThrow(FROZEN);
  }, 120_000);

  it('tenant B\'s draft run is unaffected by tenant A\'s freeze (two tenants, 10x amounts)', async () => {
    const made = await b.api.createRun(1);
    const run = String(made.body.data!.id);
    expect((await b.api.calculate(run)).statusCode).toBe(200);
    await asAppUser(b.company, b.admin, (c) => c.query('UPDATE payroll_run_lines SET net_pay = net_pay WHERE run_id = $1', [run]));
    await asAppUser(b.company, b.admin, (c) => c.query('UPDATE payroll_run_headers SET total_net = total_net WHERE id = $1', [run]));
  }, 120_000);
});

describe('FZ: what the app writes on a final run still goes through', () => {
  it('approval froze the payslip snapshot on every line; a snapshot-only write is allowed', async () => {
    const snaps = (await a.pool.query('SELECT count(*)::int AS n FROM payroll_run_lines WHERE run_id = $1 AND payslip_snapshot IS NOT NULL', [run1])).rows[0]!.n;
    expect(snaps).toBe(2);
    await app((c) => c.query('UPDATE payroll_run_lines SET payslip_snapshot = payslip_snapshot WHERE run_id = $1', [run1]));
  }, 60_000);

  it('reopen, reverse, recalculate with a raise, approve again: the fresh journal links onto the final run', async () => {
    const run = await approvedRun(3);
    const first = String((await a.header(run)).journal_entry_id);
    expect((await a.api.reopen(run)).statusCode).toBe(200);
    expect((await a.api.reverse(first)).statusCode).toBe(200);
    const salaryRow = (await a.pool.query(
      'SELECT id FROM payroll_employee_components WHERE employee_id = $1', [emp[0]])).rows[0]!.id;
    await a.setSalary(salaryRow, 26000);
    expect((await a.api.calculate(run)).statusCode).toBe(200);
    await a.authorise(run);
    const again = await a.api.approve(run);
    expect(again.statusCode, JSON.stringify(again.body)).toBe(200);
    const h = await a.header(run);
    expect(h.status).toBe('approved');
    expect(String(h.journal_entry_id)).not.toBe(first);
    await a.setSalary(salaryRow, 25000);
  }, 240_000);
});
