/**
 * Shared rig calls for the employee-portal suites (wave 6 SS): the real staff routes (withAuth, app_user, RLS) through
 * brkr.helpers' rig, with a CAPTURE mailer, and the real portal routes called with a cookie jar. Nothing here can
 * reach a mail server: the invite route is built with `capture`, and every address is @example.invalid (rule 21).
 */
import type { NextApiRequest } from 'next';
import { als } from '@/lib/als';
import type { EmailOptions } from '@/modules/accounting/services/core/emailService';
import type { Mailer } from '@/modules/accounting/services/payroll/payslipDeliveryService';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withNoStore } from '@/lib/auth/withNoStore';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { employeePortalAccessHandler } from '@/lib/employeePortalApi';
import settings from '../../pages/api/payroll/settings/employee-portal';
import login from '../../pages/api/employee-portal/login';
import accept from '../../pages/api/employee-portal/accept';
import me from '../../pages/api/employee-portal/me';
import { type Res, type Route, type rig } from './brkr.helpers';
import { applyCookies, response } from './mfa-impersonation-postgres.helpers';

export type R = Awaited<ReturnType<typeof rig>>;
type Opts = { company?: string; user?: string };

export const captured: EmailOptions[] = [];
export const failNext = { count: 0 };
export const capture: Mailer = async (o) => {
  if (failNext.count > 0) {
    failNext.count -= 1;
    return { success: false, error: '550 mailbox unavailable', provablyNotSent: true };
  }
  captured.push(o);
  return { success: true, messageId: `<ss-${captured.length}@example.invalid>` };
};
// The page's exact middleware (pages/api/payroll/employees/[id]/portal-access.ts), around a capture mailer.
const accessRoute = withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(employeePortalAccessHandler(capture)))))) as unknown as Route;

export const invite = (r: R, employeeId: string, o: Opts = {}) =>
  r.call(accessRoute, 'POST', `/api/payroll/employees/${employeeId}/portal-access`, employeeId, { ...o, body: {} });
export const revoke = (r: R, employeeId: string, o: Opts = {}) =>
  r.call(accessRoute, 'DELETE', `/api/payroll/employees/${employeeId}/portal-access`, employeeId, o);
export const readAccess = (r: R, employeeId: string, o: Opts = {}) =>
  r.call(accessRoute, 'GET', `/api/payroll/employees/${employeeId}/portal-access`, employeeId, o);
export const putSetting = (r: R, enabled: unknown, o: Opts = {}) =>
  r.call(settings as Route, 'PUT', '/api/payroll/settings/employee-portal', undefined, { ...o, body: { enabled } });
export const reason = (x: Res) => x.body.error?.details?.reason as string | undefined;

/** The platform switch for this company only, as a platform admin would set it (never on a shared database). */
export const setPlatform = async (r: R, enabled: boolean) => {
  await r.pool.query(`DELETE FROM company_feature_overrides WHERE company_id = $1
    AND feature_id = (SELECT id FROM feature_flags WHERE code = 'payroll_employee_portal')`, [r.company]);
  await r.pool.query(`INSERT INTO company_feature_overrides (company_id, feature_id, enabled, set_by)
    SELECT $1, id, $3, $2 FROM feature_flags WHERE code = 'payroll_employee_portal'`, [r.company, r.admin, enabled]);
};

/** An employee with this address (null = none). */
export async function person(r: R, email: string | null, first = 'Thandi'): Promise<string> {
  const { employee } = await r.employee(20000);
  await r.pool.query('UPDATE payroll_employees SET email = $2, first_name = $3 WHERE id = $1', [employee, email, first]);
  return employee;
}

/** The invitation token from the last captured mail (it rides in the link's fragment). */
export function lastToken(): string {
  const m = /#t=([A-Za-z0-9_-]{43})"/.exec(captured.at(-1)!.html);
  if (!m) throw new Error('no token in the captured invitation');
  return m[1]!;
}

/** A portal request: only the cookies in `jar`, from `ip`. */
export async function portal(route: unknown, method: string, jar: Record<string, string>, body?: unknown, ip = '198.51.100.7'): Promise<Res & { headers: Map<string, unknown> }> {
  const req = {
    method, url: '/api/employee-portal', query: {}, body, cookies: { ...jar },
    headers: { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/json', 'x-forwarded-for': ip },
    socket: { remoteAddress: ip },
  } as unknown as NextApiRequest;
  const result = response();
  // A portal request runs with no staff request context, as in a fresh Next request (a staff call before it in the
  // same test would otherwise leave its context on this async chain).
  await als.exit(() => (route as (q: never, s: never) => Promise<unknown>)(req as never, result.res as never));
  const set = result.headers.get('set-cookie');
  if (typeof set === 'string') result.headers.set('set-cookie', [set]);
  applyCookies(jar, result);
  return Object.assign(result.state as Res, { headers: result.headers });
}
export const doLogin = (jar: Record<string, string>, body: unknown, ip?: string) => portal(login, 'POST', jar, body, ip);
export const doAccept = (jar: Record<string, string>, body: unknown, ip?: string) => portal(accept, 'POST', jar, body, ip);
export const doMe = (jar: Record<string, string>) => portal(me, 'GET', jar);

export async function cleanup(r: R): Promise<void> {
  await r.pool.query('DELETE FROM employee_portal_access WHERE company_id = $1', [r.company]);
  await r.pool.query('DELETE FROM company_feature_overrides WHERE company_id = $1', [r.company]);
  await r.pool.query('DELETE FROM impersonation_sessions WHERE actor_user_id = $1', [r.approver]);
  await r.pool.query('DELETE FROM payroll_company_settings WHERE company_id = $1', [r.company]);
  await r.teardown();
}
