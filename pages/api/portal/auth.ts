/**
 * Client Portal — Authentication API
 * POST — login with email/password, sets signed httpOnly session cookie
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { authenticatePortalUser } from '@/modules/accounting/services/ar/portalService';
import { signArPortalToken } from '@/lib/auth/arPortalJwt';
import cookie from 'cookie';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const ip = getClientIp(req);
  if (!(await checkRateLimit(`portal-auth:${ip}`, { max: 5, windowSecs: 15 * 60 }))) {
    return res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
    });
  }

  const { email, password } = req.body;
  if (!email || !password) {
    return apiResponse.badRequest(res, 'email and password are required');
  }

  const user = await authenticatePortalUser(email, password);
  if (!user) {
    return apiResponse.unauthorized(res, 'Invalid email or password');
  }
  if (!user.companyId) {
    // Customer row exists but no company_id — shouldn't happen; fail closed.
    return apiResponse.unauthorized(res, 'Portal account misconfigured');
  }

  const token = await signArPortalToken({
    clientId: user.clientId,
    companyId: user.companyId,
    email: user.email,
  });

  res.setHeader('Set-Cookie', cookie.serialize('portal_session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 60 * 60 * 24,
  }));

  return apiResponse.success(res, { user });
}

export default withErrorHandler(handler);
