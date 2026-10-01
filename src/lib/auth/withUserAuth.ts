import { IMPERSONATION_PROOF_COOKIE } from './impersonation-cookies';
// src/lib/auth/withUserAuth.ts
import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import { verifyToken } from './gotrue';
import { parseCookies, clearAuthCookies, ACCESS_COOKIE } from './cookies';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { isActiveUserAccount, SUSPENDED_ACCOUNT_ERROR, type UserAccountRow } from './userAccountStatus';

export interface UserAuthedRequest extends NextApiRequest {
  user: { id: string; email?: string; claims: Record<string, unknown> };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => any;

/** Back-compat alias — callers that imported AuthenticatedNextApiRequest from middleware.ts */
export type AuthenticatedNextApiRequest = UserAuthedRequest;

export function withUserAuth(handler: Handler): NextApiHandler {
  return async (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies[ACCESS_COOKIE];
    if (!token) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }
    let claims;
    try {
      claims = await verifyToken(token, cookies[IMPERSONATION_PROOF_COOKIE]);
    } catch (err) {
      log.warn('withUserAuth: invalid token', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
      clearAuthCookies(res);
      return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } });
    }

    // Account-standing gate. These routes are company-less (profile, change
    // password, switch company, accept invitation), so there is no
    // company_users row to join through — the profile is looked up directly.
    //
    // Unlike withAuth this is deliberately NOT an existence check: /api/auth/me
    // and the onboarding wizard legitimately run between GoTrue signup and
    // tenantProvisioningService's INSERT INTO users, so a missing row means
    // "not provisioned yet", not "revoked". Only a row that exists and says
    // it is not in good standing denies.
    const profile = await sql<UserAccountRow>`
      SELECT is_active, status, suspended_at
      FROM users
      WHERE id = ${claims.sub}
      LIMIT 1
    `;
    const account = profile[0];
    if (account && !isActiveUserAccount(account)) {
      log.warn('withUserAuth: account not in good standing', { userId: claims.sub, url: req.url }, 'Auth');
      clearAuthCookies(res);
      return res.status(403).json({ success: false, error: { ...SUSPENDED_ACCOUNT_ERROR } });
    }

    (req as UserAuthedRequest).user = {
      id: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      claims: claims as Record<string, unknown>,
    };
    return handler(req, res);
  };
}
