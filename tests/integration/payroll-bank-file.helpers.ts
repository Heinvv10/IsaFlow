/**
 * Shared rig calls for the salary bank-file suites (wave 6 BF): the real routes through brkr.helpers' rig.
 */
import bankFile from '../../pages/api/payroll/runs/[id]/bank-file/index';
import settle from '../../pages/api/payroll/runs/[id]/bank-file/[fileId]/[action]';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { rig, type Res, type Route } from './brkr.helpers';

export type R = Awaited<ReturnType<typeof rig>>;
type Opts = { company?: string; user?: string };
export const ACTION_DATE = '2099-01-15';

export const generate = (r: R, runId: string, o: Opts & { actionDate?: string } = {}) =>
  r.call(bankFile as Route, 'POST', `/api/payroll/runs/${runId}/bank-file`, runId, { ...o, body: { actionDate: o.actionDate ?? ACTION_DATE } });
export const status = (r: R, runId: string, o: Opts = {}) => r.call(bankFile as Route, 'GET', `/api/payroll/runs/${runId}/bank-file`, runId, o);
export const act = (r: R, runId: string, fileId: string, action: string, o: Opts & { body?: unknown } = {}): Promise<Res> => {
  const route = ((req: { query: Record<string, unknown> }, res: unknown) => {
    req.query = { ...req.query, fileId, action };
    return (settle as unknown as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
  }) as unknown as Route;
  return r.call(route, 'POST', `/api/payroll/runs/${runId}/bank-file/${fileId}/${action}`, runId, o);
};
export const voidNotSent = (r: R, runId: string, fileId: string, o: Opts = {}) => act(r, runId, fileId, 'void', { ...o, body: { notSentToBank: true } });
export const reason = (x: Res) => x.body.error?.details?.reason as string | undefined;
export const files = async (r: R) => (await r.pool.query(
  `SELECT id, run_id, status, sha256, line_count, total_cents::text AS total_cents, void_not_sent, created_by, voided_by, confirmed_by
     FROM payroll_bank_files WHERE company_id = $1 ORDER BY created_at, id`, [r.company])).rows;
export const exports = async (r: R) => Number((await r.pool.query(
  "SELECT count(*) FROM audit_log WHERE company_id = $1 AND entity_type = 'payroll_bank_file'", [r.company])).rows[0]!.count);
export const enable = (r: R) => r.pool.query(
  `INSERT INTO company_feature_overrides (company_id, feature_id, enabled, set_by)
   SELECT $1, id, true, $2 FROM feature_flags WHERE code = 'payroll_salary_bank_file'`, [r.company, r.admin]);
export const payingAccount = async (r: R) => {
  await r.pool.query("UPDATE gl_accounts SET bank_account_number = '62000000001', bank_branch_code = '250655' WHERE company_id = $1 AND account_code = '1110'", [r.company]);
  clearSystemAccountCache(r.company);
};
/** Bank details as of 2020 (created_at in the past: before any approval in these suites). */
export const bank = (r: R, employee: string, account: string, branch = '632005', active = true) => r.pool.query(
  `INSERT INTO payroll_bank_details (company_id, employee_id, bank_name, account_number, account_type, branch_code, account_holder, is_active, effective_from, created_at)
   VALUES ($1, $2, 'ABSA', $3, 'savings', $4, NULL, $5, '2020-01-01', '2020-01-01')`, [r.company, employee, account, branch, active]);
export const approvedRun = async (r: R, month: number) => {
  const id = await r.calculatedRun(month);
  const ap = await r.api.approve(id);
  if (ap.statusCode !== 200) throw new Error(`approve ${month}: ${ap.statusCode} ${JSON.stringify(ap.body)}`);
  return id;
};
/** Reopen, recalculate, clear and approve again. */
export const reapprove = async (r: R, runId: string) => {
  if ((await r.api.reopen(runId)).statusCode !== 200) throw new Error('reopen');
  if ((await r.api.calculate(runId)).statusCode !== 200) throw new Error('calculate');
  await r.authorise(runId);
  const ap = await r.api.approve(runId);
  if (ap.statusCode !== 200) throw new Error(`re-approve: ${ap.statusCode} ${JSON.stringify(ap.body)}`);
};
export const cleanup = async (r: R) => {
  await r.pool.query('DELETE FROM payroll_bank_file_items WHERE company_id = $1', [r.company]);
  await r.pool.query('DELETE FROM payroll_bank_files WHERE company_id = $1', [r.company]);
  await r.pool.query('DELETE FROM payroll_bank_details WHERE company_id = $1', [r.company]);
  await r.pool.query('DELETE FROM company_feature_overrides WHERE company_id = $1', [r.company]);
  await r.teardown();
};
