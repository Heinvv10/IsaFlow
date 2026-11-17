/**
 * Salary bank file (wave 6 BF): the money controls from review #1524 (breaker repros BRK-1..5, folded in), plus nil
 * net pay. Each asserts the safe behaviour through the real routes, withAuth, app_user and RLS.
 *   BRK-1 a 'paid' run gets no file (BANK_HAS_PAID).
 *   BRK-2 bank details changed after approval (through the real PUT route) refuse, naming the employee, until the run
 *         is re-approved.
 *   BRK-3 lines changed after approval refuse (RUN_CHANGED_SINCE_APPROVAL): the file pays only the approved total.
 *   BRK-4 a file made before a reopen is never voided by the generator: the next generate is UNSETTLED_FILE (with its
 *         sha, total and date) until a person voids it attesting it was not sent, or confirms it.
 *   BRK-5 app_user cannot forge a file for an unapproved run, nor stamp another user as its maker.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bankDetails from '../../pages/api/payroll/employees/[id]/bank-details';
import { rig, type Route } from './brkr.helpers';
import {
  act, approvedRun, bank, cleanup, enable, files, generate, payingAccount, reapprove, reason, voidNotSent, type R,
} from './payroll-bank-file.helpers';

let a: R;
const emp: string[] = [];

/** As app_user under this tenant's RLS with a session user, as withAuth sets it. */
async function asAppUser<T>(sub: string, fn: (q: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub, role: 'authenticated' })]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [a.company]);
    const out = await fn((text, values) => c.query(text, values as unknown[]));
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally { c.release(); await pool.end(); }
}

beforeAll(async () => {
  a = await rig('bank-file-controls');
  await a.setup();
  emp.push((await a.employee(25000)).employee, (await a.employee(18000)).employee);
  await enable(a);
  await payingAccount(a);
  await bank(a, emp[0]!, '4071234567');
  await bank(a, emp[1]!, '1234567890', '470010');
}, 180_000);
afterAll(async () => { await cleanup(a); });

describe('salary bank file money controls (review #1524)', () => {
  it('BRK-1: a run marked paid gets no file', async () => {
    const run = await approvedRun(a, 1);
    await a.pool.query("UPDATE payroll_run_headers SET status = 'paid' WHERE id = $1", [run]);
    const res = await generate(a, run);
    expect([res.statusCode, reason(res)]).toEqual([409, 'BANK_HAS_PAID']);
    expect((await files(a)).length).toBe(0);
  }, 120_000);

  it('BRK-2: details changed after approval refuse, naming the employee, until the run is re-approved', async () => {
    const run = await approvedRun(a, 2);
    const put = await a.call(bankDetails as Route, 'PUT', `/api/payroll/employees/${emp[0]}/bank-details`, emp[0], {
      body: { bankName: 'FNB', branchCode: '250655', accountNumber: '62999999999', accountType: 'cheque' },
    });
    expect(put.statusCode).toBe(200);
    const res = await generate(a, run);
    expect([res.statusCode, reason(res)]).toEqual([409, 'BANK_DETAILS_CHANGED']);
    expect(res.body.error.details.problems).toEqual(['BRK-1 Brk BRK-1']);
    expect(String(res.body.error.message)).toMatch(/Reopen and re-approve/);
    expect((await files(a)).length).toBe(0);
    await reapprove(a, run);
    const after = await generate(a, run);
    expect(after.statusCode).toBe(200);
    expect(String(after.body.data!.content)).toContain('62999999999');
    await voidNotSent(a, run, String(after.body.data!.id));
  }, 180_000);

  it('BRK-3: lines changed after approval refuse; the file pays only the approved total', async () => {
    const run = await approvedRun(a, 3);
    await asAppUser(a.admin, (q) => q('UPDATE payroll_run_lines SET net_pay = net_pay + 500 WHERE run_id = $1 AND employee_id = $2', [run, emp[1]]));
    const res = await generate(a, run);
    expect([res.statusCode, reason(res)]).toEqual([409, 'RUN_CHANGED_SINCE_APPROVAL']);
    expect((await files(a)).filter((f) => f.run_id === run)).toEqual([]);
  }, 120_000);

  it('BRK-4: a file made before a reopen blocks the next until voided with the attestation; never auto-voided', async () => {
    const run = await approvedRun(a, 4);
    const first = await generate(a, run);
    expect(first.statusCode).toBe(200);
    await reapprove(a, run);
    const blocked = await generate(a, run);
    expect([blocked.statusCode, reason(blocked)]).toEqual([409, 'UNSETTLED_FILE']);
    expect(String(blocked.body.error.message)).toContain(String(first.body.data!.sha256).slice(0, 12));
    expect(String(blocked.body.error.message)).toContain('2099-01-15');
    expect((await files(a)).filter((f) => f.run_id === run).map((f) => f.status)).toEqual(['generated']);

    const unattested = await act(a, run, String(first.body.data!.id), 'void', { body: {} });
    expect([unattested.statusCode, reason(unattested)]).toEqual([400, 'NOT_SENT_REQUIRED']);
    expect((await voidNotSent(a, run, String(first.body.data!.id))).statusCode).toBe(200);
    const second = await generate(a, run);
    expect(second.statusCode).toBe(200);
    expect((await files(a)).filter((f) => f.run_id === run).map((f) => [f.status, f.void_not_sent, f.voided_by]))
      .toEqual([['voided', true, a.admin], ['generated', false, null]]);
  }, 180_000);

  it('BRK-4: a pre-reopen file the bank did pay is confirmed, and then no new file is made', async () => {
    const run = await approvedRun(a, 5);
    const first = await generate(a, run);
    await reapprove(a, run);
    expect((await act(a, run, String(first.body.data!.id), 'confirm')).statusCode).toBe(200);
    expect(reason(await generate(a, run))).toBe('BANK_HAS_PAID');
  }, 180_000);

  it('BRK-5: app_user cannot forge a file for an unapproved run, nor name another maker', async () => {
    const run = await a.calculatedRun(6);
    const forge = (runId: string, by: string) => asAppUser(a.admin, (q) => q(
      `INSERT INTO payroll_bank_files (company_id, run_id, format, layout, sha256, line_count, total_cents, action_date, run_approved_at, created_by)
       SELECT $1, h.id, 'acb', 'fnb_obe_2023_02', repeat('a', 64), 1, 1, '2099-01-01', COALESCE(h.approved_at, now()), $3
         FROM payroll_run_headers h WHERE h.id = $2 RETURNING created_by`, [a.company, runId, by]));
    await expect(forge(run, a.admin)).rejects.toThrow(/for an approved run, at its current approval/);
    const approved = await approvedRun(a, 7);
    const made = await forge(approved, 'nobody');
    expect(made.rows[0]!.created_by).toBe(a.admin);
  }, 180_000);

  it('nil net pay is left out of the file and named; the run is not refused', async () => {
    const zero = (await a.employee(0)).employee;
    const run = await approvedRun(a, 8);
    const nil = (await a.pool.query('SELECT net_pay::float8 AS n FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [run, zero])).rows[0];
    expect(nil?.n).toBe(0);
    const res = await generate(a, run);
    expect(res.statusCode).toBe(200);
    expect(res.body.data!.lineCount).toBe(2);
    expect(res.body.data!.warnings).toContain('BRK-3 Brk BRK-3: not in the file: net pay is nil');
  }, 180_000);
});
