/**
 * POST /api/employee-portal/accept  { token, password }  ->  activates the login and sets the session cookie
 *
 * Wave 6 SS (employeePortalLogin.acceptEmployeeInvite). The token is the one in the invitation link's fragment; it
 * works once, within 7 days, and only while the portal is open for the employer and the employee. Judged before the
 * write: the IP limit (10 in 15 minutes), the body, the password rule. Every answer is no-store.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withNoStore } from '@/lib/auth/withNoStore';
import { setEmployeePortalCookie } from '@/lib/auth/employeePortalAuth';
import { respondIfEmployeePortalRefused } from '@/lib/employeePortalApi';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { acceptEmployeeInvite, judgePassword } from '@/modules/accounting/services/payroll/employeePortalLogin';

const Body = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), password: z.string().max(1024) }).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  if (!(await checkRateLimit(`employee-portal-accept-ip:${getClientIp(req)}`, { max: 10, windowSecs: 15 * 60 }))) {
    return apiResponse.error(res, ErrorCode.RATE_LIMIT, 'Too many attempts. Please try again in 15 minutes.', { reason: 'RATE_LIMITED' });
  }
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, 'This invitation link is not complete. Open it again from the email.');
  try {
    const claims = await acceptEmployeeInvite(parsed.data.token, judgePassword(parsed.data.password));
    await setEmployeePortalCookie(res, claims);
    return apiResponse.success(res, { signedIn: true });
  } catch (err) {
    if (respondIfEmployeePortalRefused(res, err)) return;
    throw err;
  }
}

export default withNoStore(withErrorHandler(handler, { maskBodyKeys: ['token', 'password'] }));
