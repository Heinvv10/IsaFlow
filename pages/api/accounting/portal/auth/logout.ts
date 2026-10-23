// pages/api/accounting/portal/auth/logout.ts — POST
// Clears portal_session cookie, then 303s to the portal login page. Sign out is
// a plain HTML form post, so a JSON answer would leave the director on a raw page.

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';

const PORTAL_COOKIE_NAME = 'portal_session';
// Constant targets — nothing in the request can re-point them (no open redirect).
const LOGIN_PATH = '/accounting/afs/portal/login';
const SIGNED_OUT_PATH = `${LOGIN_PATH}?signed_out=1`;
const REFUSED_PATH = `${LOGIN_PATH}?error=signout_failed`;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  // CSRF defence-in-depth — a post from an unexpected origin clears nothing and
  // lands on the login page told that sign out did not complete.
  const origin = req.headers.origin;
  const expectedOrigin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za';
  if (origin && origin !== expectedOrigin) {
    log.warn('Portal logout refused: unexpected origin', { origin }, 'portal-logout-api');
    return res.redirect(303, REFUSED_PATH);
  }

  const isProduction = process.env.NODE_ENV !== 'development';
  const securePart = isProduction ? ' Secure;' : '';

  res.setHeader('Set-Cookie', [
    `${PORTAL_COOKIE_NAME}=; HttpOnly;${securePart} SameSite=Lax; Path=/; Max-Age=0`,
  ]);

  log.info('Portal session cleared', {}, 'portal-logout-api');
  return res.redirect(303, SIGNED_OUT_PATH);
}

export default withErrorHandler(handler as never);
