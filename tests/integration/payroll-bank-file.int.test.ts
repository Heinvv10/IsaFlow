/**
 * Salary bank file (wave 6 BF) through the real routes, withAuth, app_user and RLS, on two tenants.
 * Claims: every refusal changes no row; a file records its sha256 and totals and an audit `export`; confirm writes
 * only the file (the run stays approved and reopenable, spec 0a.17); a reopen warns BANK_FILE_CONFIRMED; the bank
 * having paid refuses a second file; a reopen makes a generated file stale (no confirm; the next file voids it);
 * another tenant sees and touches nothing.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { createHash } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import bankFile from '../../pages/api/payroll/runs/[id]/bank-file/index';
import settle from '../../pages/api/payroll/runs/[id]/bank-file/[fileId]/[action]';
import { rig, type Res, type Route } from './brkr.helpers';

let a: Awaited<ReturnType<typeof rig>>;
let b: Awaited<ReturnType<typeof rig>>;
const ACTION_DATE = '2099-01-15';
const emp: string[] = [];

type R = typeof a;
const generate = (r: R, runId: string, o: { company?: string; user?: string; actionDate?: string } = {}) =>
  r.call(bankFile as Route, 'POST', `/api/payroll/runs/${runId}/bank-file`, runId, { ...o, body: { actionDate: o.actionDate ?? ACTION_DATE } });
const status = (r: R, runId: string, o: { company?: string; user?: string } = {}) =>
  r.call(bankFile as Route, 'GET', `/api/payroll/runs/${runId}/bank-file`, runId, o);
const act = (r: R, runId: string, fileId: string, action: string, o: { company?: string; user?: string } = {}): Promise<Res> => {
  const call = r.call as unknown as (route: Route, m: string, u: string, id: unknown, opts: object) => Promise<Res>;
  return call(((req: { query: Record<string, unknown> }, res: unknown) => {
    req.query = { ...req.query, fileId, action };
    return (settle as unknown as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
  }) as unknown as Route, 'POST', `/api/payroll/runs/${runId}/bank-file/${fileId}/${action}`, runId, o);
};
const reason = (x: Res) => x.body.error?.details?.reason as string | undefined;
const files = async (r: R) => (await r.pool.query(
  'SELECT id, run_id, status, sha256, line_count, total_cents::text AS total_cents FROM payroll_bank_files WHERE company_id = $1 ORDER BY created_at, id', [r.company])).rows;
const exports = async (r: R) => Number((await r.pool.query(
  "SELECT count(*) FROM audit_log WHERE company_id = $1 AND entity_type = 'payroll_bank_file'", [r.company])).rows[0]!.count);
const enable = (r: R) => r.pool.query(
  `INSERT INTO company_feature_overrides (company_id, feature_id, enabled, set_by)
   SELECT $1, id, true, $2 FROM feature_flags WHERE code = 'payroll_salary_bank_file'`, [r.company, r.admin]);
const bank = (r: R, employee: string, account: string, branch = '632005') => r.pool.query(
  `INSERT INTO payroll_bank_details (company_id, employee_id, bank_name, account_number, account_type, branch_code, account_holder, is_active, effective_from)
   VALUES ($1, $2, 'ABSA', $3, 'savings', $4, NULL, true, '2020-01-01')`, [r.company, employee, account, branch]);
const approvedRun = async (r: R, month: number) => {
  const id = await r.calculatedRun(month);
  const ap = await r.api.approve(id);
  if (ap.statusCode !== 200) throw new Error(`approve ${month}: ${ap.statusCode} ${JSON.stringify(ap.body)}`);
  return id;
};

beforeAll(async () => {
  a = await rig('bank-file-a');
  b = await rig('bank-file-b');
  await a.setup();
  await b.setup();
  emp.push((await a.employee(25000)).employee, (await a.employee(18000)).employee);
  await b.employee(30000);
}, 120_000);
afterAll(async () => {
  for (const r of [a, b]) {
    await r.pool.query('DELETE FROM payroll_bank_files WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM payroll_bank_details WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM company_feature_overrides WHERE company_id = $1', [r.company]);
    await r.teardown();
  }
});

describe('salary bank file', () => {
  let run1 = '';

  it('refuses, writing nothing: switch off, not final, no paying account, unpayable employees', async () => {
    run1 = await a.calculatedRun(1);
    expect(reason(await generate(a, run1))).toBe('FEATURE_DISABLED');
    await enable(a);
    expect(reason(await generate(a, run1))).toBe('NOT_FINAL');
    expect((await a.api.approve(run1)).statusCode).toBe(200);
    const noAccount = await generate(a, run1);
    expect([noAccount.statusCode, reason(noAccount)]).toEqual([409, 'NO_PAYING_ACCOUNT']);
    await a.pool.query("UPDATE gl_accounts SET bank_account_number = '62000000001', bank_branch_code = '250655' WHERE company_id = $1 AND account_code = '1110'", [a.company]);
    clearSystemAccountCache(a.company);
    await bank(a, emp[0]!, '123456789012'); // 12 digits: not an ACB account
    const unpayable = await generate(a, run1);
    expect(reason(unpayable)).toBe('EMPLOYEES_NOT_PAYABLE');
    expect(unpayable.body.error.details.problems).toEqual(['BRK-1: Account number must be at most 11 digits', 'BRK-2: no active bank details']);
    expect(await files(a)).toEqual([]);
    expect(await exports(a)).toBe(0);
  });

  it('generates the file: in the body, recorded with its sha256 and totals, audited; a second is refused', async () => {
    await a.pool.query("UPDATE payroll_bank_details SET account_number = '4071234567' WHERE company_id = $1", [a.company]);
    await bank(a, emp[1]!, '1234567890', '470010');
    const res = await generate(a, run1);
    expect(res.statusCode).toBe(200);
    const body = res.body.data!;
    const lines = String(body.content).split('\r\n').slice(0, -1);
    expect(lines.map((l) => l.slice(0, 2))).toEqual(['02', '04', '10', '10', '12', '92', '94']);
    expect(lines[4]!.slice(58, 64)).toBe('990115');
    expect(body.totalCents).toBe(Math.round((await a.header(run1)).net * 100));
    expect(body.sha256).toBe(createHash('sha256').update(String(body.content), 'latin1').digest('hex'));
    expect(await files(a)).toMatchObject([{ status: 'generated', sha256: body.sha256, line_count: 2, total_cents: String(body.totalCents) }]);
    expect(await exports(a)).toBe(1);
    expect(reason(await generate(a, run1))).toBe('FILE_EXISTS');
    expect((await files(a)).length).toBe(1);
  });

  it('another tenant sees none of it and cannot generate, confirm or void it', async () => {
    const [file] = await files(a);
    expect((await status(b, run1)).body.data!.files).toEqual([]);
    expect(reason(await generate(b, run1))).toBe('FEATURE_DISABLED');
    await enable(b);
    expect(reason(await generate(b, run1))).toBe('NOT_FOUND');
    expect(reason(await act(b, run1, String(file!.id), 'confirm'))).toBe('NOT_FOUND');
    expect(reason(await act(b, run1, String(file!.id), 'void'))).toBe('NOT_FOUND');
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
    expect((await status(a, run1)).body.data!.paymentConfirmed).toBe(true);
    expect(reason(await act(a, run1, String(file!.id), 'void'))).toBe('NOT_GENERATED');

    const reopened = await a.api.reopen(run1);
    expect(reopened.statusCode).toBe(200);
    expect(reopened.body.data!.warnings.map((w: { code: string }) => w.code)).toEqual(['BANK_FILE_CONFIRMED']);
    expect((await a.api.calculate(run1)).statusCode).toBe(200);
    await a.authorise(run1);
    expect((await a.api.approve(run1)).statusCode).toBe(200);
    expect(reason(await generate(a, run1))).toBe('BANK_HAS_PAID');
    expect((await files(a)).map((f) => f.status)).toEqual(['confirmed']);
  });

  it('a reopen makes a generated file stale: it cannot be confirmed, and the next file voids it', async () => {
    const run2 = await approvedRun(a, 2);
    const first = await generate(a, run2);
    expect(first.statusCode).toBe(200);
    const reopened = await a.api.reopen(run2);
    expect(reopened.body.data!.warnings.map((w: { code: string }) => w.code)).toEqual(['BANK_FILE_GENERATED']);
    expect((await status(a, run2)).body.data!.files[0].stale).toBe(true);
    expect(reason(await act(a, run2, String(first.body.data!.id), 'confirm'))).toBe('STALE');
    expect((await a.api.calculate(run2)).statusCode).toBe(200);
    await a.authorise(run2);
    expect((await a.api.approve(run2)).statusCode).toBe(200);
    const second = await generate(a, run2);
    expect(second.statusCode).toBe(200);
    const rows = (await files(a)).filter((f) => f.run_id === run2);
    expect(rows.map((f) => [f.id, f.status])).toEqual([[first.body.data!.id, 'voided'], [second.body.data!.id, 'generated']]);
    expect((await act(a, run2, String(second.body.data!.id), 'void')).body.data).toEqual({ id: second.body.data!.id, status: 'voided' });
  });

  it('the table refuses a forged transition or a changed fact', async () => {
    const [file] = await files(a);
    await expect(a.pool.query("UPDATE payroll_bank_files SET status = 'generated', confirmed_at = NULL, confirmed_by = NULL WHERE id = $1", [file!.id]))
      .rejects.toThrow(/only a generated file/);
    await expect(a.pool.query("UPDATE payroll_bank_files SET total_cents = 1 WHERE id = $1", [file!.id])).rejects.toThrow(/only a generated file/);
  });
});
