/**
 * Wave 6 FZ (migration 999n): a FINAL pay run's figures are frozen in the database.
 * Final = R-035's isPayRunFinal: status approved or paid with approved_at or approval_grandfathered_at.
 * Folds in the PR #1524 breaker repros BRK-3 and D-1 as refusals (IsaFlow-rev1524-repros).
 * Each forgery runs as app_user under the tenant's RLS and claims (what withAuth sets), and the key
 * ones again as migration_admin (BYPASSRLS, not a superuser). A superuser session is exempt (it can disable
 * any trigger anyway); production has none on its app, deploy or admin pools, the fixture's postgres is one. The app's own writes on a
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
/** One transaction as a non-superuser role that bypasses RLS (production's migration_admin). */
async function asRole(role: string, fn: (c: PoolClient) => Promise<unknown>): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${role}`);
    expect((await c.query("SELECT current_setting('is_superuser') AS su")).rows[0]!.su).toBe('off');
    await fn(c);
    await c.query('COMMIT');
  } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); await pool.end(); }
}
const app = (fn: (c: PoolClient) => Promise<unknown>) => asAppUser(a.company, a.admin, fn);
/**
 * One transaction as migration_admin with session_replication_role = replica, which skips every trigger not ENABLE
 * ALWAYS. The fixture's superuser first grants SET on that parameter (PG15+), as a hosting platform may; all of it
 * rolls back, the grant included. Proves each 999n trigger is ENABLE ALWAYS.
 */
async function inReplica(fn: (c: PoolClient) => Promise<unknown>): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('GRANT SET ON PARAMETER session_replication_role TO migration_admin');
    await c.query('SET LOCAL ROLE migration_admin');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    expect((await c.query("SELECT current_setting('is_superuser') AS su")).rows[0]!.su).toBe('off');
    await fn(c);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); await pool.end(); }
}
/** Every frozen header column, moved alone: dropping any one from 999n's tuple turns its row red. */
const HEADER_MOVES: Array<[string, string]> = [
  ['company_id', 'company_id = (SELECT c.id FROM companies c WHERE c.id <> payroll_run_headers.company_id LIMIT 1)'],
  ['run_date', "run_date = COALESCE(run_date + 1, DATE '2026-01-25')"],
  ['pay_frequency', "pay_frequency = pay_frequency || 'x'"],
  ['run_kind', "run_kind = run_kind || 'x'"],
  ['period_start', "period_start = COALESCE(period_start + 1, DATE '2026-01-01')"],
  ['period_end', "period_end = COALESCE(period_end + 1, DATE '2026-01-31')"],
  ...['total_gross', 'total_taxable', 'total_paye', 'total_uif', 'total_sdl', 'total_eti', 'total_net', 'employee_count']
    .map((col): [string, string] => [col, `${col} = ${col} + 1`]),
  ['posted_journal_entry_id', 'posted_journal_entry_id = CASE WHEN posted_journal_entry_id IS NULL THEN gen_random_uuid() END'],
];
/**
 * The period alone. payroll_run_headers_fill_period (BEFORE, ENABLE ORIGIN) re-derives period_start/end when a
 * monthly regular run's year or month moves, so outside replica those columns would refuse it and mask a dropped
 * year or month. In replica that trigger is skipped and only 999n's tuple sees the move.
 */
const PERIOD_MOVES: Array<[string, string]> = [
  ['period_year', 'period_year = period_year + 1'],
  ['period_month', 'period_month = period_month % 12 + 1'],
];

async function approvedRun(month: number): Promise<string> {
  const id = await a.calculatedRun(month);
  const ap = await a.api.approve(id);
  if (ap.statusCode !== 200) throw new Error(`approve ${month}: ${ap.statusCode} ${JSON.stringify(ap.body)}`);
  return id;
}
const lineNet = async (run: string, e: string) => Number((await a.pool.query(
  'SELECT net_pay FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [run, e])).rows[0]!.net_pay);

let run1 = '';
let grandRun = '';

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

  it('a final run whose journal is out may drop that link, and then links only its own posted payroll journal', async () => {
    const run = await approvedRun(4);
    const first = String((await a.header(run)).journal_entry_id);
    expect((await a.api.reopen(run)).statusCode).toBe(200);
    expect((await a.api.reverse(first)).statusCode).toBe(200);
    // Back to final with the reversed journal still linked (a legacy shape approval's `replaces` unlink meets).
    await a.pool.query("UPDATE payroll_run_headers SET status = 'approved', approved_at = now() WHERE id = $1", [run]);
    await app((c) => c.query('UPDATE payroll_run_headers SET journal_entry_id = NULL WHERE id = $1', [run]));
    const manual = (await a.pool.query(
      `INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
       VALUES ($1, '2026-04-25', 'Payroll run 2026-04', 'manual', 'posted', $2) RETURNING id`, [a.company, a.admin])).rows[0]!.id;
    await expect(app((c) => c.query('UPDATE payroll_run_headers SET journal_entry_id = $2 WHERE id = $1', [run, manual]))).rejects.toThrow(FROZEN);
    await expect(app((c) => c.query('UPDATE payroll_run_headers SET journal_entry_id = $2 WHERE id = $1', [run, first]))).rejects.toThrow(FROZEN);
  }, 120_000);

  it('approval stamps cannot be cleared while the run stays approved (the freeze would lapse)', async () => {
    await expect(app((c) => c.query('UPDATE payroll_run_headers SET approved_at = NULL WHERE id = $1', [run1]))).rejects.toThrow(FROZEN);
    await expect(app((c) => c.query('UPDATE payroll_run_headers SET approved_at = approved_at - interval \'1 day\' WHERE id = $1', [run1]))).rejects.toThrow(FROZEN);
  }, 60_000);

  it('a grandfathered final run (approved_at NULL) keeps its grandfather stamp and its lines', async () => {
    grandRun = await approvedRun(6);
    // R-035's legacy shape: approved, no approved_at, approval_grandfathered_at set; no journal linked.
    await a.pool.query('UPDATE payroll_run_headers SET approved_at = NULL, approval_grandfathered_at = now(), journal_entry_id = NULL WHERE id = $1', [grandRun]);
    const STAMPS = /approval stamps are frozen/;
    await expect(app((c) => c.query('UPDATE payroll_run_headers SET approval_grandfathered_at = NULL WHERE id = $1', [grandRun]))).rejects.toThrow(STAMPS);
    await expect(app((c) => c.query("UPDATE payroll_run_headers SET approval_grandfathered_at = approval_grandfathered_at - interval '1 day' WHERE id = $1", [grandRun])))
      .rejects.toThrow(STAMPS);
    await expect(app((c) => c.query('UPDATE payroll_run_lines SET net_pay = net_pay + 1 WHERE run_id = $1', [grandRun])))
      .rejects.toThrow(/payroll_run_lines: a final pay run's figures are frozen/);
  }, 120_000);

  it('a final run links no other company\'s posted payroll journal, only its own (BYPASSRLS role)', async () => {
    const posted = async (company: string, user: string) => String((await a.pool.query(
      `INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
       VALUES ($1, '2026-06-25', 'Payroll run 2026-06', 'auto_payroll', 'posted', $2) RETURNING id`, [company, user])).rows[0]!.id);
    const link = (je: string) => asRole('migration_admin', (c) => c.query('UPDATE payroll_run_headers SET journal_entry_id = $2 WHERE id = $1', [grandRun, je]));
    await expect(link(await posted(b.company, b.admin))).rejects.toThrow(/links only its own posted payroll journal/);
    // The control: the same shape in its own company links, so the refusal above is the company clause.
    await link(await posted(a.company, a.admin));
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
    await expect(asRole('migration_admin', (c) => c.query('UPDATE payroll_run_lines SET net_pay = net_pay + 1 WHERE run_id = $1', [run1]))).rejects.toThrow(FROZEN);
    await expect(asRole('migration_admin', (c) => c.query('UPDATE payroll_run_headers SET total_gross = 0 WHERE id = $1', [run1]))).rejects.toThrow(FROZEN);
  }, 60_000);

  it.each(HEADER_MOVES)('header column %s alone is frozen on a final run (BYPASSRLS role)', async (_col, set) => {
    await expect(asRole('migration_admin', (c) => c.query(`UPDATE payroll_run_headers SET ${set} WHERE id = $1`, [run1])))
      .rejects.toThrow(/figures are frozen/);
  }, 60_000);

  it.each(PERIOD_MOVES)('header column %s alone is frozen on a final run (period_start/end held still)', async (_col, set) => {
    await expect(inReplica((c) => c.query(`UPDATE payroll_run_headers SET ${set} WHERE id = $1`, [run1]))).rejects.toThrow(/figures are frozen/);
  }, 60_000);

  it('session_replication_role = replica skips neither trigger (both are ENABLE ALWAYS)', async () => {
    await expect(inReplica((c) => c.query('UPDATE payroll_run_lines SET net_pay = net_pay + 1 WHERE run_id = $1', [run1]))).rejects.toThrow(FROZEN);
    await expect(inReplica((c) => c.query('UPDATE payroll_run_headers SET total_net = total_net + 1 WHERE id = $1', [run1]))).rejects.toThrow(FROZEN);
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
