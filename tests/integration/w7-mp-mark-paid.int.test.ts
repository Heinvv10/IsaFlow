/**
 * Wave 7 MP (W27; Hein rulings 4 and 16; grill F2): "Mark paid" through the real routes, withAuth, app_user and RLS, on
 * a disposable fixture (rig -> assertDisposable), two tenants (B at 10x the amounts, in a later tax window).
 *
 *  - typed path: a bank payment reference + date moves an approved run to `paid`, stamped (paid_at by the clock,
 *    paid_by the session user, paid_reference, paid_on), with one audit row; the run still shows its payslips and its
 *    journal; a second mark-paid is 409 ALREADY_PAID and a reopen is 409 RUN_PAID, both changing nothing;
 *  - file path: a confirmed salary bank file paying exactly the run (paid_on = its action date, no reference);
 *  - refusals change no row: no evidence, a file only generated, a file only voided, a confirmed file paying an earlier
 *    approval's other figures, no journal linked, the journal reversed (not in force), not approved, bad references and
 *    dates, another tenant's run;
 *  - migration 1053's rules as app_user: the payment record is written once and only on a paid run;
 *  - the Demo reseed's reopen and re-finalise of a paid run (scripts/lib/demoReseed/payrollFinal.ts) and the company
 *    teardown still work.
 */
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import markPaid from '../../pages/api/payroll/runs/[id]/mark-paid';
import runDetail from '../../pages/api/payroll/runs/[id]';
import { todayInSast } from '@/lib/saDateParser';
import { finaliseRuns, reopenFinalRuns } from '../../scripts/lib/demoReseed/payrollFinal';
import { txOver } from '../../scripts/lib/demoReseed/db';
import { rig, type Res, type Route } from './brkr.helpers';
import { act, approvedRun, bank, cleanup, enable, generate, payingAccount, reason, voidNotSent, type R } from './payroll-bank-file.helpers';

let a: R;
let b: R;
const TODAY = todayInSast();
const salary: string[] = [];

const mark = (r: R, runId: string, body: unknown = {}, o: { company?: string; user?: string } = {}) =>
  r.call(markPaid as Route, 'POST', `/api/payroll/runs/${runId}/mark-paid`, runId, { ...o, body });
const head = async (r: R, id: string) => (await r.pool.query(
  `SELECT status, approved_at, journal_entry_id, paid_at, paid_by, paid_reference, paid_on::text AS paid_on, updated_at
     FROM payroll_run_headers WHERE id = $1`, [id])).rows[0]!;
const audits = async (r: R) => Number((await r.pool.query(
  "SELECT count(*) FROM audit_log WHERE company_id = $1 AND entity_type = 'payroll_run'", [r.company])).rows[0]!.count);

/** Refused with `status` and `why`; the header and the payroll-run audit trail are exactly as before. */
async function expectRefused(r: R, runId: string, body: unknown, status: number, why: string, o: { company?: string } = {}): Promise<Res> {
  const before = await head(r, runId);
  const trail = await audits(r);
  const res = await mark(r, runId, body, o);
  expect([res.statusCode, reason(res)], JSON.stringify(res.body)).toEqual([status, why]);
  expect(await head(r, runId)).toEqual(before);
  expect(await audits(r)).toBe(trail);
  return res;
}

/** As app_user under the tenant's RLS with a session user, as withAuth sets it. */
async function asAppUser<T>(r: R, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: r.admin, role: 'authenticated' })]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [r.company]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally { await c.end(); }
}

beforeAll(async () => {
  a = await rig('w7-mp-a');
  b = await rig('w7-mp-b');
  await a.setup();
  await b.setup();
  const e1 = await a.employee(25000);
  const e2 = await a.employee(18000);
  salary.push(e1.salaryRow);
  await enable(a);
  await payingAccount(a);
  await bank(a, e1.employee, '4071234567');
  await bank(a, e2.employee, '1234567890', '470010');
  await b.employee(250000);
}, 240_000);
afterAll(async () => {
  if (b) await b.teardown();
  if (a) await cleanup(a);
}, 120_000);

describe('mark paid by a typed bank payment reference', () => {
  it('stamps the run paid (who, when, reference, date), one audit row; payslips and journal still shown', async () => {
    const run = await approvedRun(a, 1);
    const trail = await audits(a);
    const res = await mark(a, run, { reference: '  FNB EFT 0001 ', paidOn: TODAY });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'paid', evidence: 'reference', paidReference: 'FNB EFT 0001', paidOn: TODAY, paidBy: a.admin });
    const h = await head(a, run);
    expect(h).toMatchObject({ status: 'paid', paid_by: a.admin, paid_reference: 'FNB EFT 0001', paid_on: TODAY });
    expect(Math.abs(new Date(h.paid_at).getTime() - Date.now())).toBeLessThan(120_000);
    expect(await audits(a)).toBe(trail + 1);
    const row = (await a.pool.query(
      "SELECT changes FROM audit_log WHERE company_id = $1 AND entity_type = 'payroll_run' AND entity_id = $2 ORDER BY created_at DESC LIMIT 1",
      [a.company, run])).rows[0]!.changes;
    expect(row.metadata).toMatchObject({ event: 'marked_paid', evidence: 'reference', paidReference: 'FNB EFT 0001', paidOn: TODAY });

    const detail = await a.call(runDetail as Route, 'GET', `/api/payroll/runs/${run}`, run);
    expect(detail.statusCode).toBe(200);
    expect(detail.body.data).toMatchObject({ status: 'paid', paidReference: 'FNB EFT 0001', paidOn: TODAY, payslipsFinal: true });
    expect(detail.body.data!.journalEntryId).toBe(h.journal_entry_id);
    expect(detail.body.data!.journalEntryId).not.toBeNull();

    await expectRefused(a, run, { reference: 'AGAIN', paidOn: TODAY }, 409, 'ALREADY_PAID');
    const before = await head(a, run);
    const reopened = await a.api.reopen(run);
    expect(reopened.statusCode).toBe(409);
    expect(reopened.body.error.details.code).toBe('RUN_PAID');
    expect(reopened.body.error.message).toMatch(/Paid runs cannot be reopened: this run was marked paid on/);
    expect(await head(a, run)).toEqual(before);
  }, 180_000);

  it('blank or over-long references and dates outside approval day .. today are refused, nothing written', async () => {
    const run = await approvedRun(a, 2);
    const tomorrow = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await expectRefused(a, run, { reference: '   ', paidOn: TODAY }, 400, 'INVALID_REFERENCE');
    await expectRefused(a, run, { reference: 'R'.repeat(65), paidOn: TODAY }, 400, 'INVALID_REFERENCE');
    await expectRefused(a, run, { reference: 'EFT1' }, 400, 'INVALID_PAID_ON');
    await expectRefused(a, run, { reference: 'EFT1', paidOn: '2020-01-01' }, 400, 'INVALID_PAID_ON');
    await expectRefused(a, run, { reference: 'EFT1', paidOn: tomorrow }, 400, 'INVALID_PAID_ON');
    // Another tenant cannot see it, let alone mark it.
    const other = await b.call(markPaid as Route, 'POST', `/api/payroll/runs/${run}/mark-paid`, run, { body: { reference: 'EFT1', paidOn: TODAY } });
    expect([other.statusCode, reason(other)]).toEqual([404, 'NOT_FOUND']);
    expect((await head(a, run)).status).toBe('approved');
    expect((await mark(a, run, { reference: 'EFT1', paidOn: TODAY })).statusCode).toBe(200);
  }, 180_000);
});

describe('mark paid by the confirmed salary bank file', () => {
  it('needs evidence: none, generated only and voided only are refused; a confirmed file pays it', async () => {
    const run = await approvedRun(a, 3);
    await expectRefused(a, run, {}, 409, 'NO_PAYMENT_EVIDENCE');
    const made = await generate(a, run, { actionDate: TODAY });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(200);
    const fileId = String(made.body.data!.id);
    await expectRefused(a, run, {}, 409, 'UNSETTLED_FILE');
    await expectRefused(a, run, { reference: 'EFT3', paidOn: TODAY }, 409, 'UNSETTLED_FILE');
    expect((await voidNotSent(a, run, fileId)).statusCode).toBe(200);
    await expectRefused(a, run, {}, 409, 'NO_PAYMENT_EVIDENCE');

    const again = await generate(a, run, { actionDate: TODAY });
    expect(again.statusCode).toBe(200);
    expect((await act(a, run, String(again.body.data!.id), 'confirm')).statusCode).toBe(200);
    const res = await mark(a, run);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ evidence: 'bank_file', paidReference: null, paidOn: TODAY });
    expect(await head(a, run)).toMatchObject({ status: 'paid', paid_reference: null, paid_on: TODAY, paid_by: a.admin });
    expect((await generate(a, run, { actionDate: TODAY })).statusCode).toBe(409); // BANK_HAS_PAID: never a second file
  }, 240_000);

  it('a confirmed file of an earlier approval with other figures is refused (FILE_TOTALS_DIFFER); a typed payment of the rest marks it', async () => {
    const run = await approvedRun(a, 4);
    const made = await generate(a, run, { actionDate: TODAY });
    expect((await act(a, run, String(made.body.data!.id), 'confirm')).statusCode).toBe(200);
    const journal = String((await head(a, run)).journal_entry_id);
    expect((await a.api.reopen(run)).statusCode).toBe(200);
    expect((await a.api.reverse(journal)).statusCode).toBe(200); // other figures: the old journal goes first
    await a.setSalary(salary[0]!, 26000);
    try {
      expect((await a.api.calculate(run)).statusCode).toBe(200);
      await a.authorise(run);
      const ap = await a.api.approve(run);
      expect(ap.statusCode, JSON.stringify(ap.body)).toBe(200);
    } finally { await a.setSalary(salary[0]!, 25000); }
    const res = await expectRefused(a, run, {}, 409, 'FILE_TOTALS_DIFFER');
    expect(res.body.error.message).toMatch(/still owed/);
    expect((await mark(a, run, { reference: 'EFT DIFF 4', paidOn: TODAY })).statusCode).toBe(200);
  }, 300_000);
});

describe('the run\'s own journal must be posted and in force (grill F2)', () => {
  it('not approved, no journal linked, and a reversed journal are refused', async () => {
    const calculated = await a.calculatedRun(5);
    await expectRefused(a, calculated, { reference: 'EFT5', paidOn: TODAY }, 409, 'NOT_APPROVED');

    // Approved, then reopened, its journal reversed, and put back to approved raw (as legacy data can be).
    const run = await approvedRun(a, 6);
    const journal = String((await head(a, run)).journal_entry_id);
    expect((await a.api.reopen(run)).statusCode).toBe(200);
    expect((await a.api.reverse(journal)).statusCode).toBe(200);
    await a.pool.query("UPDATE payroll_run_headers SET status = 'approved', approved_at = clock_timestamp() WHERE id = $1", [run]);
    const res = await expectRefused(a, run, { reference: 'EFT6', paidOn: TODAY }, 409, 'JOURNAL_NOT_IN_FORCE');
    expect(res.body.error.message).toMatch(/is not in force/);

    const bare = (await a.pool.query(
      `INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, approved_at, pay_frequency, period_start, period_end)
       VALUES ($1, 2026, 7, 'approved', clock_timestamp(), 'monthly', '2026-07-01', '2026-07-31') RETURNING id`, [a.company])).rows[0]!.id;
    await expectRefused(a, String(bare), { reference: 'EFT7', paidOn: TODAY }, 409, 'JOURNAL_NOT_IN_FORCE');
    await a.pool.query('DELETE FROM payroll_run_headers WHERE id = $1', [bare]);
  }, 240_000);
});

describe('tenant B (10x, a later tax window) and migration 1053 as app_user', () => {
  let bRun: string;
  it('B marks its own run paid; A\'s runs are untouched', async () => {
    const aBefore = (await a.pool.query('SELECT id, status, paid_reference FROM payroll_run_headers WHERE company_id = $1 ORDER BY id', [a.company])).rows;
    bRun = await b.calculatedRun(1, 2027);
    const ap = await b.api.approve(bRun);
    expect(ap.statusCode, JSON.stringify(ap.body)).toBe(200);
    const res = await mark(b, bRun, { reference: 'B-EFT-2027-01', paidOn: TODAY });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(Number((await b.pool.query('SELECT total_net FROM payroll_run_headers WHERE id = $1', [bRun])).rows[0]!.total_net)).toBeGreaterThan(100_000);
    expect((await a.pool.query('SELECT id, status, paid_reference FROM payroll_run_headers WHERE company_id = $1 ORDER BY id', [a.company])).rows).toEqual(aBefore);
  }, 180_000);

  it('the payment record is written once, only on a paid run, and paid_at is the clock', async () => {
    await expect(asAppUser(b, (c) => c.query("UPDATE payroll_run_headers SET paid_reference = 'FORGED' WHERE id = $1", [bRun])))
      .rejects.toThrow(/written once/);
    await expect(asAppUser(b, (c) => c.query("UPDATE payroll_run_headers SET paid_at = '2000-01-01' WHERE id = $1", [bRun])))
      .rejects.toThrow(/written once/);
    const draft = String((await b.api.createRun(2, {}, 2027)).body.data!.id);
    await expect(asAppUser(b, (c) => c.query("UPDATE payroll_run_headers SET paid_reference = 'X', paid_on = '2027-02-01' WHERE id = $1", [draft])))
      .rejects.toThrow(/only written when the run is marked paid/);
    const ok = await asAppUser(b, (c) => c.query("UPDATE payroll_run_headers SET notes = 'w7 mp' WHERE id = $1", [bRun]));
    expect(ok.rowCount).toBe(1); // other columns of a paid run still update
    const constraints = (await b.pool.query(
      `SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'payroll_run_headers'::regclass
        AND conname IN ('payroll_run_headers_paid_at_set', 'payroll_run_headers_paid_reference_len') ORDER BY conname`)).rows;
    expect(constraints).toEqual([
      { conname: 'payroll_run_headers_paid_at_set', convalidated: true },
      { conname: 'payroll_run_headers_paid_reference_len', convalidated: true },
    ]);
  }, 120_000);

  it('the Demo reseed\'s reopen and re-finalise of a paid run still work; the company teardown deletes it', async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query('BEGIN');
      const tx = txOver(c);
      const approvedAt = (await c.query('SELECT approved_at FROM payroll_run_headers WHERE id = $1', [bRun])).rows[0]!.approved_at;
      expect(await reopenFinalRuns(tx, b.company)).toBe(1);
      expect((await c.query('SELECT status, paid_at, paid_by, paid_reference, paid_on FROM payroll_run_headers WHERE id = $1', [bRun])).rows[0])
        .toEqual({ status: 'calculated', paid_at: null, paid_by: null, paid_reference: null, paid_on: null });
      await finaliseRuns(tx, b.company, [{ id: bRun, status: 'paid', approved_at: approvedAt, approval_grandfathered_at: null }]);
      const after = (await c.query('SELECT status, paid_at FROM payroll_run_headers WHERE id = $1', [bRun])).rows[0]!;
      expect(after.status).toBe('paid');
      expect(after.paid_at).not.toBeNull();
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally { await c.end(); }
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      await pool.query('DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = $1)', [b.company]);
      await pool.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [b.company]);
      expect(Number((await pool.query('SELECT count(*) FROM payroll_run_headers WHERE company_id = $1', [b.company])).rows[0]!.count)).toBe(0);
    } finally { await pool.end(); }
  }, 120_000);
});
