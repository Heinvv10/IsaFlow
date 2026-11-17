/**
 * Salary bank file (wave 6 BF): review #1524 round 2 (breaker delta repros D-1..D-3, folded in).
 *   D-1  fail closed on the approved figures: lines + header total moved together, the journal unlinked or reversed,
 *        are refused (JOURNAL_NOT_POSTED); with the journal still linked the drift is RUN_CHANGED_SINCE_APPROVAL.
 *   D-2  re-activating an older bank row after approval counts as changed details (activated_at, 999h).
 *   D-3  a pre-reopen file confirmed against a re-approval with other figures names the difference, both ways.
 * D-4 (claims-based actor restamp) is a documented residual in the 999h header, not a control.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig } from './brkr.helpers';
import {
  act, approvedRun, bank, cleanup, enable, files, generate, payingAccount, reason, status, type R,
} from './payroll-bank-file.helpers';

let a: R;
const emp: { employee: string; salaryRow: string }[] = [];

async function asAppUser(fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: a.admin, role: 'authenticated' })]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [a.company]);
    await fn(c);
    await c.query('COMMIT');
  } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); await pool.end(); }
}

/** Reopen, change employee 0's salary, recalculate, reverse the first approval's journal, approve again. */
async function reapproveAt(run: string, salary: number): Promise<void> {
  const je = String((await a.header(run)).journal_entry_id);
  await a.setSalary(emp[0]!.salaryRow, salary);
  expect((await a.api.reopen(run)).statusCode).toBe(200);
  expect((await a.api.calculate(run)).statusCode).toBe(200);
  expect((await a.api.reverse(je)).statusCode).toBe(200);
  await a.authorise(run);
  expect((await a.api.approve(run)).statusCode).toBe(200);
  await a.setSalary(emp[0]!.salaryRow, 25000);
}

beforeAll(async () => {
  a = await rig('bank-file-delta');
  await a.setup();
  emp.push(await a.employee(25000), await a.employee(18000));
  await enable(a);
  await payingAccount(a);
  await bank(a, emp[0]!.employee, '4071234567');
  await bank(a, emp[1]!.employee, '1234567890', '470010');
}, 180_000);
afterAll(async () => { await cleanup(a); });

describe('salary bank file, review #1524 round 2', () => {
  it('D-1: lines and header moved together with the journal unlinked are refused JOURNAL_NOT_POSTED', async () => {
    const run = await approvedRun(a, 1);
    await asAppUser(async (c) => {
      await c.query('UPDATE payroll_run_lines SET net_pay = net_pay + 50000 WHERE run_id = $1 AND employee_id = $2', [run, emp[0]!.employee]);
      await c.query('UPDATE payroll_run_headers SET total_net = total_net + 50000, journal_entry_id = NULL WHERE id = $1', [run]);
    });
    const res = await generate(a, run);
    expect([res.statusCode, reason(res)]).toEqual([409, 'JOURNAL_NOT_POSTED']);
    expect(String(res.body.error.message)).toMatch(/Post the payroll journal first/);
  }, 120_000);

  it('D-1b: the same drift with the journal still linked is RUN_CHANGED_SINCE_APPROVAL', async () => {
    const run = await approvedRun(a, 2);
    await asAppUser(async (c) => {
      await c.query('UPDATE payroll_run_lines SET net_pay = net_pay + 50000 WHERE run_id = $1 AND employee_id = $2', [run, emp[0]!.employee]);
      await c.query('UPDATE payroll_run_headers SET total_net = total_net + 50000 WHERE id = $1', [run]);
    });
    expect(reason(await generate(a, run))).toBe('RUN_CHANGED_SINCE_APPROVAL');
  }, 120_000);

  it('D-1c: an approved run whose journal was reversed gets no file', async () => {
    const run = await approvedRun(a, 3);
    const je = String((await a.header(run)).journal_entry_id);
    // The app refuses to reverse an approved run's journal; a reversal by any other path still leaves no anchor.
    expect((await a.api.reverse(je)).statusCode).toBe(400);
    await a.pool.query('UPDATE gl_journal_entries SET reversed_at = now() WHERE id = $1', [je]);
    expect(reason(await generate(a, run))).toBe('JOURNAL_NOT_POSTED');
    expect((await files(a)).filter((f) => f.run_id === run)).toEqual([]);
  }, 120_000);

  it('D-2: re-activating an older bank row after approval is refused as changed details', async () => {
    await bank(a, emp[0]!.employee, '62888888888', '250655', false);
    const run = await approvedRun(a, 4);
    await asAppUser(async (c) => {
      await c.query('UPDATE payroll_bank_details SET is_active = false WHERE employee_id = $1 AND is_active', [emp[0]!.employee]);
      await c.query("UPDATE payroll_bank_details SET is_active = true WHERE employee_id = $1 AND account_number = '62888888888'", [emp[0]!.employee]);
    });
    const res = await generate(a, run);
    expect([res.statusCode, reason(res)]).toEqual([409, 'BANK_DETAILS_CHANGED']);
    await a.pool.query("UPDATE payroll_bank_details SET is_active = false WHERE employee_id = $1 AND account_number = '62888888888'", [emp[0]!.employee]);
    await a.pool.query("UPDATE payroll_bank_details SET is_active = true, activated_at = NULL WHERE employee_id = $1 AND account_number = '4071234567'", [emp[0]!.employee]);
  }, 120_000);

  it.each([
    ['still to pay (the re-approval pays more)', 5, 40000, 1],
    ['overpaid (the re-approval pays less)', 6, 15000, -1],
  ])('D-3: a pre-reopen file confirmed against a re-approval names the difference: %s', async (_name, month, salary, sign) => {
    const run = await approvedRun(a, month);
    const first = await generate(a, run);
    expect(first.statusCode).toBe(200);
    await reapproveAt(run, salary);
    const currentCents = Math.round((await a.header(run)).net * 100);
    const diff = currentCents - Number(first.body.data!.totalCents);
    expect(Math.sign(diff)).toBe(sign);
    const ok = await act(a, run, String(first.body.data!.id), 'confirm');
    expect(ok.body.data).toEqual({ id: first.body.data!.id, status: 'confirmed', differenceCents: diff });
    const st = (await status(a, run)).body.data!;
    expect(st.files[0]).toMatchObject({ status: 'confirmed', differenceCents: diff });
    expect(reason(await generate(a, run))).toBe('BANK_HAS_PAID');
  }, 240_000);
});
