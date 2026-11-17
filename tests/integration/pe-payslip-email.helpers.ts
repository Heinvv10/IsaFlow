/**
 * Shared rig calls for the payslip-email suites (wave 6 PE): the real routes (withAuth, app_user, RLS) through
 * brkr.helpers' rig, with a CAPTURE mailer. Nothing here can reach a mail server: the send route is built with
 * `capture`, and every address is @example.invalid (spec rule 21).
 */
import { SignJWT } from 'jose';
import type { EmailOptions } from '@/modules/accounting/services/core/emailService';
import type { Mailer } from '@/modules/accounting/services/payroll/payslipDeliveryService';
import { payslipEmailRoute } from '@/lib/payslipEmailApi';
import settings from '../../pages/api/payroll/settings/payslip-email';
import employeeEmail from '../../pages/api/payroll/employees/[id]/email';
import { rig, type Res, type Route } from './brkr.helpers';
import { impersonationToken } from './r035-pr2.helpers';

export type R = Awaited<ReturnType<typeof rig>>;
type Opts = { company?: string; user?: string };

export const captured: EmailOptions[] = [];
/** Fails the next N sends (a mail server refusing them). */
export const failNext = { count: 0 };
export const capture: Mailer = async (o) => {
  if (failNext.count > 0) {
    failNext.count -= 1;
    return { success: false, error: '550 mailbox unavailable', provablyNotSent: true };
  }
  captured.push(o);
  return { success: true, messageId: `<pe-${captured.length}@example.invalid>` };
};
const sendRoute = payslipEmailRoute(capture) as unknown as Route;

export const send = (r: R, runId: string, o: Opts & { body?: unknown } = {}) =>
  r.call(sendRoute, 'POST', `/api/payroll/runs/${runId}/payslips/email`, runId, { ...o, body: o.body ?? {} });
export const putSetting = (r: R, enabled: unknown, o: Opts = {}) =>
  r.call(settings as Route, 'PUT', '/api/payroll/settings/payslip-email', undefined, { ...o, body: { enabled } });
export const getSetting = (r: R, o: Opts = {}) => r.call(settings as Route, 'GET', '/api/payroll/settings/payslip-email', undefined, o);
export const putEmail = (r: R, employeeId: string, body: unknown, o: Opts = {}) =>
  r.call(employeeEmail as Route, 'PUT', `/api/payroll/employees/${employeeId}/email`, employeeId, { ...o, body });
export const reason = (x: Res) => x.body.error?.details?.reason as string | undefined;

/** The platform switch for this company only, as a platform admin would set it (never on a shared database). */
export const enablePlatform = (r: R) => r.pool.query(
  `INSERT INTO company_feature_overrides (company_id, feature_id, enabled, set_by)
   SELECT $1, id, true, $2 FROM feature_flags WHERE code = 'payroll_payslip_email'`, [r.company, r.admin]);

export const deliveries = async (r: R) => (await r.pool.query(
  `SELECT employee_id, run_id, recipient_email, pdf_sha256, status, message_id, error, resend, sent_by,
          (run_approved_at = (SELECT COALESCE(approved_at, approval_grandfathered_at) FROM payroll_run_headers h WHERE h.id = d.run_id)) AS current
     FROM payslip_deliveries d WHERE company_id = $1 ORDER BY created_at, id`, [r.company])).rows;
export const audits = async (r: R, entityType: string) => Number((await r.pool.query(
  'SELECT count(*) FROM audit_log WHERE company_id = $1 AND entity_type = $2', [r.company, entityType])).rows[0]!.count);

/** A token for `target` whose session is a platform admin's Login-as; stored in the rig as user `as`. */
export async function loginAs(r: R, target: string, as = 'login-as'): Promise<string> {
  r.tokens[as] = await impersonationToken(r.pool, target, r.approver);
  return as;
}
/** A token with no session id (an agent or a job). */
export async function agent(r: R, user: string, as = 'agent'): Promise<string> {
  r.tokens[as] = await new SignJWT({ sub: user, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return as;
}

/** An employee with the identity and address given (null = none). */
export async function person(r: R, salary: number, o: { email: string | null; idNumber?: string | null; passport?: string | null }): Promise<string> {
  const { employee } = await r.employee(salary);
  await r.pool.query('UPDATE payroll_employees SET email = $2, id_number = $3, passport_number = $4 WHERE id = $1',
    [employee, o.email, o.idNumber ?? null, o.passport ?? null]);
  return employee;
}

export const approvedRun = async (r: R, month: number) => {
  const id = await r.calculatedRun(month);
  const ap = await r.api.approve(id);
  if (ap.statusCode !== 200) throw new Error(`approve ${month}: ${ap.statusCode} ${JSON.stringify(ap.body)}`);
  return id;
};
export const reapprove = async (r: R, runId: string) => {
  if ((await r.api.reopen(runId)).statusCode !== 200) throw new Error('reopen');
  if ((await r.api.calculate(runId)).statusCode !== 200) throw new Error('calculate');
  await r.authorise(runId);
  const ap = await r.api.approve(runId);
  if (ap.statusCode !== 200) throw new Error(`re-approve: ${ap.statusCode} ${JSON.stringify(ap.body)}`);
};

export async function cleanup(r: R): Promise<void> {
  await r.pool.query('DELETE FROM payslip_deliveries WHERE company_id = $1', [r.company]);
  await r.pool.query('DELETE FROM company_feature_overrides WHERE company_id = $1', [r.company]);
  await r.pool.query('DELETE FROM impersonation_sessions WHERE actor_user_id = $1', [r.approver]);
  await r.pool.query('DELETE FROM payroll_company_settings WHERE company_id = $1', [r.company]);
  await r.teardown();
}
