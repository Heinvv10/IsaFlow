/**
 * POST /api/employee-portal/login  { email, password, accessId? }  ->  sets the employee_portal_session cookie
 *
 * Wave 6 SS (employeePortalLogin.signInEmployee). No staff session. SameSite=Strict on the session cookie does not
 * stop a cross-site POST from SETTING it (login CSRF), so the route first refuses anything but a same-origin JSON
 * POST (withEmployeePortalSameOrigin, review #1570 L1). The address is normalised once (employeePortalAddress: trim,
 * NFKC, lowercase; non-ASCII is 400), and that one value keys the per-address bucket and the lookup (review M1). The
 * brute-force limit, charged before any lookup, on every attempt: 5 per address and 20 per IP in 15 minutes (429),
 * so neither a spread of addresses from one IP nor a spread of IPs on one address gets more guesses.
 * A wrong password, an unknown address and a revoked login are the same 401. A password that opens logins at several
 * employers is 409 CHOOSE_EMPLOYER naming them; the page re-posts with `accessId`. Every answer is no-store.
 */
import { createHash } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withNoStore } from '@/lib/auth/withNoStore';
import { setEmployeePortalCookie } from '@/lib/auth/employeePortalAuth';
import { withEmployeePortalSameOrigin } from '@/lib/auth/employeePortalSameOrigin';
import { respondIfEmployeePortalRefused } from '@/lib/employeePortalApi';
import { UUID } from '@/lib/payslipEmailApi';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { signInEmployee } from '@/modules/accounting/services/payroll/employeePortalLogin';
import { normalisePortalEmail } from '@/modules/accounting/services/payroll/employeePortalAddress';

const Body = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(1024),
  accessId: z.string().regex(UUID).optional(),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, 'email and password are required');
  const { password, accessId } = parsed.data;
  const email = normalisePortalEmail(parsed.data.email);
  if (!email) return apiResponse.badRequest(res, 'Enter the email address your employer has on file, in plain letters.');
  const ip = getClientIp(req);
  const who = createHash('sha256').update(email).digest('hex');
  if (!(await checkRateLimit(`employee-portal-login-ip:${ip}`, { max: 20, windowSecs: 900 }))
    || !(await checkRateLimit(`employee-portal-login-email:${who}`, { max: 5, windowSecs: 900 }))) {
    return apiResponse.error(res, ErrorCode.RATE_LIMIT, 'Too many attempts. Please try again in 15 minutes.', { reason: 'RATE_LIMITED' });
  }
  try {
    const result = await signInEmployee(email, password, accessId);
    if (result.kind === 'refused') return apiResponse.unauthorized(res, 'The email address or password is not right.');
    if (result.kind === 'choose') {
      return apiResponse.error(res, ErrorCode.CONFLICT, 'Choose the employer to sign in to.', { reason: 'CHOOSE_EMPLOYER', employers: result.employers });
    }
    await setEmployeePortalCookie(res, result.claims);
    return apiResponse.success(res, { signedIn: true });
  } catch (err) {
    if (respondIfEmployeePortalRefused(res, err)) return;
    throw err;
  }
}

export default withNoStore(withErrorHandler(withEmployeePortalSameOrigin(handler), { maskBodyKeys: ['email', 'password'] }));
