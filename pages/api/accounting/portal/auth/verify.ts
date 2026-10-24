// pages/api/accounting/portal/auth/verify.ts — GET
// Consumes magic link token, signs portal JWT, sets HttpOnly cookie, redirects.

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { verifyMagicLink } from '@/modules/accounting/services/afs/magicLinkService';
import { signPortalToken } from '@/lib/auth/portalJwt';
import type { PortalSession } from '@/modules/accounting/services/afs/afsTypes';

const PORTAL_COOKIE_NAME = 'portal_session';
const SESSION_TTL_HOURS = 8;
const SESSION_MAX_AGE = SESSION_TTL_HOURS * 3600;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = req.query.token as string | undefined;
  if (!token) {
    return res.redirect(302, '/accounting/afs/portal/login?error=missing_token');
  }
  // A link's token is 64 hex characters (magicLinkService). Anything else, and
  // more than 20 tries a minute from one address, is answered before the lookup
  // takes one of the migration_admin pool's few connections (S-07d).
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return res.redirect(302, '/accounting/afs/portal/login?error=expired');
  }
  const ip = getClientIp(req);
  if (!(await checkRateLimit(`afs-portal-verify:${ip}`, { max: 20, windowSecs: 60 }))) {
    log.warn('Portal verify rate limit exceeded', { ip }, 'portal-verify-api');
    // The login page shows its generic "request a new link" message for this code.
    return res.redirect(302, '/accounting/afs/portal/login?error=rate_limited');
  }

  const result = await verifyMagicLink(token);
  if (!result) {
    return res.redirect(302, '/accounting/afs/portal/login?error=expired');
  }

  const { contact, companyId } = result;
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();

  const session: PortalSession = {
    contactId: contact.id,
    companyId,
    role: contact.role,
    expiresAt,
  };

  const jwt = await signPortalToken(session, `${SESSION_TTL_HOURS}h`);
  const isProduction = process.env.NODE_ENV !== 'development';
  const securePart = isProduction ? ' Secure;' : '';

  res.setHeader('Set-Cookie', [
    `${PORTAL_COOKIE_NAME}=${jwt}; HttpOnly;${securePart} SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`,
  ]);

  log.info('Portal session created via magic link', { contactId: contact.id, companyId }, 'portal-verify-api');
  return res.redirect(302, '/accounting/afs/portal/dashboard');
}

export default withErrorHandler(handler as never);
