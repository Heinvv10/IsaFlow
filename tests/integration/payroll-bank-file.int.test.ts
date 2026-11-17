/**
 * Salary bank file (wave 6 BF) through the real routes, withAuth, app_user and RLS, on two tenants.
 * Claims: every refusal changes no row; a file records its sha256 and totals and an audit `export`; confirm writes
 * only the file (the run stays approved and reopenable, spec 0a.17); a reopen warns BANK_FILE_CONFIRMED; the bank
 * having paid refuses a second file; another tenant sees and touches nothing; the table stamps the session user and
 * refuses forged rows. The money controls of review #1524 (BRK-1..5) are in payroll-bank-file-controls.int.test.ts.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { createHash } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayInSast } from '@/lib/saDateParser';
import { rig } from './brkr.helpers';
import {
  act, approvedRun, bank, cleanup, reapprove, enable, exports, files, generate, payingAccount, reason, status, voidNotSent, type R,
} from './payroll-bank-file.helpers';

let a: R;
let b: R;
const emp: string[] = [];
let run1 = '';

beforeAll(async () => {
  a = await rig('bank-file-a');
  b = await rig('bank-file-b');
  await a.setup();
  await b.setup();
  emp.push((await a.employee(25000)).employee, (await a.employee(18000)).employee);
  await b.employee(30000);
}, 120_000);
afterAll(async () => {
  for (const r of [a, b]) await cleanup(r);
});

describe('salary bank file', () => {
  it('refuses, writing nothing: switch off, not final, bad action dates, no paying account, unpayable employees', async () => {
    run1 = await a.calculatedRun(1);
    expect(reason(await generate(a, run1))).toBe('FEATURE_DISABLED');
    await enable(a);
    expect(reason(await generate(a, run1))).toBe('NOT_FINAL');
    await bank(a, emp[0]!, '123456789012'); // 12 digits: not an ACB account
    await bank(a, emp[1]!, '1234567890', '470010', false); // inactive: no active details
    expect((await a.api.approve(run1)).statusCode).toBe(200);
    const noAccount = await generate(a, run1);
    expect([noAccount.statusCode, reason(noAccount)]).toEqual([409, 'NO_PAYING_ACCOUNT']);
    await payingAccount(a);
    const yesterday = new Date(Date.parse(`${todayInSast()}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    for (const actionDate of [yesterday, '2099-02-30']) {
      const bad = await generate(a, run1, { actionDate });
      expect([bad.statusCode, reason(bad)], actionDate).toEqual([400, 'INVALID_ACTION_DATE']);
    }
    const unpayable = await generate(a, run1);
    expect(reason(unpayable)).toBe('EMPLOYEES_NOT_PAYABLE');
    expect(unpayable.body.error.details.problems).toEqual(['BRK-1: Account number must be at most 11 digits', 'BRK-2: no active bank details']);
    expect(await files(a)).toEqual([]);
    expect(await exports(a)).toBe(0);
  });

  it('generates the file: in the body, recorded with its sha256, totals and session user, audited; a second is refused', async () => {
    await a.pool.query("UPDATE payroll_bank_details SET account_number = '4071234567' WHERE company_id = $1 AND employee_id = $2", [a.company, emp[0]]);
    await a.pool.query('UPDATE payroll_bank_details SET is_active = true WHERE company_id = $1 AND employee_id = $2', [a.company, emp[1]]);
    // Activated after the approval (999h stamps activated_at): refused until the run is approved again (D-2).
    expect(reason(await generate(a, run1))).toBe('BANK_DETAILS_CHANGED');
    await reapprove(a, run1);
    const res = await generate(a, run1);
    expect(res.statusCode).toBe(200);
    const body = res.body.data!;
    const lines = String(body.content).split('\r\n').slice(0, -1);
    expect(lines.map((l) => [l.slice(0, 2), l.length])).toEqual([['02', 180], ['04', 180], ['10', 180], ['10', 180], ['12', 180], ['92', 180], ['94', 180]]);
    expect(lines[4]!.slice(58, 64)).toBe('990115');
    expect(body.totalCents).toBe(Math.round((await a.header(run1)).net * 100));
    expect(body.sha256).toBe(createHash('sha256').update(String(body.content), 'latin1').digest('hex'));
    expect(await files(a)).toMatchObject([{ status: 'generated', sha256: body.sha256, line_count: 2, total_cents: String(body.totalCents), created_by: a.admin }]);
    expect(await exports(a)).toBe(1);
    expect(reason(await generate(a, run1))).toBe('FILE_EXISTS');
    expect((await files(a)).length).toBe(1);
  });

  it('another tenant sees none of it and cannot generate, confirm or void it, by its own run either', async () => {
    const [file] = await files(a);
    expect((await status(b, run1)).body.data!.files).toEqual([]);
    await enable(b);
    expect(reason(await generate(b, run1))).toBe('NOT_FOUND');
    expect(reason(await act(b, run1, String(file!.id), 'confirm'))).toBe('NOT_FOUND');
    expect(reason(await voidNotSent(b, run1, String(file!.id)))).toBe('NOT_FOUND');
    const bRun = await b.calculatedRun(1);
    expect(reason(await act(b, bRun, String(file!.id), 'confirm'))).toBe('NOT_FOUND');
    expect(reason(await voidNotSent(b, bRun, String(file!.id)))).toBe('NOT_FOUND');
    expect((await files(a))[0]!.status).toBe('generated');
  });

  it('a manager may read the status but not write; a viewer may not read', async () => {
    const manager = await a.addUser('manager');
    const viewer = await a.addUser('viewer');
    expect((await status(a, run1, { user: manager })).statusCode).toBe(200);
    expect((await generate(a, run1, { user: manager })).statusCode).toBe(403);
    expect((await act(a, run1, String((await files(a))[0]!.id), 'confirm', { user: manager })).statusCode).toBe(403);
    expect((await status(a, run1, { user: viewer })).statusCode).toBe(403);
    expect((await files(a))[0]!.status).toBe('generated');
  });

  it('confirm records the bank acceptance only: the run stays approved; reopen warns; the bank having paid refuses a new file', async () => {
    const [file] = await files(a);
    const before = (await a.pool.query('SELECT status, approved_at, paid_at FROM payroll_run_headers WHERE id = $1', [run1])).rows[0];
    const ok = await act(a, run1, String(file!.id), 'confirm');
    expect([ok.statusCode, ok.body.data]).toEqual([200, { id: file!.id, status: 'confirmed' }]);
    expect((await a.pool.query('SELECT status, approved_at, paid_at FROM payroll_run_headers WHERE id = $1', [run1])).rows[0]).toEqual(before);
    expect((await files(a))[0]).toMatchObject({ confirmed_by: a.admin });
    expect((await status(a, run1)).body.data!.paymentConfirmed).toBe(true);
    expect(reason(await voidNotSent(a, run1, String(file!.id)))).toBe('NOT_GENERATED');

    const reopened = await a.api.reopen(run1);
    expect(reopened.statusCode).toBe(200);
    expect(reopened.body.data!.warnings.map((w: { code: string }) => w.code)).toEqual(['BANK_FILE_CONFIRMED']);
    expect((await a.api.calculate(run1)).statusCode).toBe(200);
    await a.authorise(run1);
    expect((await a.api.approve(run1)).statusCode).toBe(200);
    expect(reason(await generate(a, run1))).toBe('BANK_HAS_PAID');
    expect((await files(a)).map((f) => f.status)).toEqual(['confirmed']);
  });

  it('two generates at once: one file, the other refused FILE_EXISTS', async () => {
    const run = await approvedRun(a, 2);
    const both = await Promise.all([generate(a, run), generate(a, run)]);
    expect(both.map((x) => x.statusCode).sort()).toEqual([200, 409]);
    expect(both.map(reason).filter(Boolean)).toEqual(['FILE_EXISTS']);
    expect((await files(a)).filter((f) => f.run_id === run).length).toBe(1);
  });

  it('a live file committed between the judge and the insert is answered FILE_EXISTS (23505 mapped), not a 500', async () => {
    const run = await approvedRun(a, 3);
    const c = await a.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: a.admin })]);
      await c.query(
        `INSERT INTO payroll_bank_files (company_id, run_id, layout, sha256, line_count, total_cents, action_date, run_approved_at, created_by)
         SELECT company_id, id, 'fnb_obe_2023_02', repeat('b', 64), 1, 1, '2099-01-15', COALESCE(approved_at, approval_grandfathered_at), 'x'
           FROM payroll_run_headers WHERE id = $1`, [run]);
      const pending = generate(a, run); // its judge cannot see the uncommitted row; its insert waits on the unique index
      await new Promise((ok) => setTimeout(ok, 1500));
      await c.query('COMMIT');
      const res = await pending;
      expect([res.statusCode, reason(res)]).toEqual([409, 'FILE_EXISTS']);
    } finally { c.release(); }
    expect((await files(a)).filter((f) => f.run_id === run).map((f) => f.sha256)).toEqual(['b'.repeat(64)]);
  });

  it('the table refuses a forged transition, a changed fact, and a write with no session user', async () => {
    const [file] = await files(a);
    await expect(a.pool.query("UPDATE payroll_bank_files SET status = 'generated', confirmed_at = NULL, confirmed_by = NULL WHERE id = $1", [file!.id]))
      .rejects.toThrow(/session user|only a generated file/);
    await expect(a.pool.query('UPDATE payroll_bank_files SET total_cents = 1 WHERE id = $1', [file!.id])).rejects.toThrow(/session user|only a generated file/);
  });
});
