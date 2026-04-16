// pages/api/accounting/portal/auth/logout.ts — POST
// Clears portal_session cookie.

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';

const PORTAL_COOKIE_NAME = 'portal_session';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const isProduction = process.env.NODE_ENV !== 'development';
  const securePart = isProduction ? ' Secure;' : '';

  res.setHeader('Set-Cookie', [
    `${PORTAL_COOKIE_NAME}=; HttpOnly;${securePart} SameSite=Lax; Path=/; Max-Age=0`,
  ]);

  log.info('Portal session cleared', {}, 'portal-logout-api');
  return apiResponse.success(res, { loggedOut: true });
}

export default withErrorHandler(handler as never);
