// pages/api/auth/2fa-challenge.ts
// Called by the client after /api/auth/login returns {requires_2fa: true, ...}.
// Completes the GoTrue challenge using the short-lived pending_token, then
// sets the real sb-access-token / sb-refresh-token cookies.
import type { NextApiHandler } from 'next';
import {
  setAuthCookies,
  setActiveCompanyCookie,
  clearPendingMfaCookie,
  parseCookies,
  PENDING_MFA_COOKIE,
} from '@/lib/auth/cookies';
import { challengeFactor, verifyFactor, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { verifyToken } from '@/lib/auth/gotrue';
import { checkLockout, recordFailure, clearLockout } from '@/lib/auth/accountLockout';
import { checkRateLimit, getClientIp, withRateLimit } from '@/lib/rateLimit';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const { factor_id, code } = req.body ?? {};
  if (typeof factor_id !== 'string' || typeof code !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'factor_id and code required' } });
  }

  // Pentest H6: pending_token is now read from the HttpOnly cookie set by
  // /api/auth/login. Body-provided tokens (old client) are still tolerated
  // for the current release so clients can be rolled out gradually; remove
  // the body fallback after the frontend lands the cookie-based flow.
  const cookiePendingToken = parseCookies(req)[PENDING_MFA_COOKIE];
  const bodyPendingToken = typeof req.body?.pending_token === 'string' ? req.body.pending_token : '';
  const pending_token = cookiePendingToken || bodyPendingToken;
  if (!pending_token) {
    return res.status(401).json({ success: false, error: { code: 'NO_PENDING_TOKEN', message: 'Pending session missing' } });
  }

  // Per-factor brute-force guard — 5 attempts / 15 min per factor_id beats
  // IP-rotating attackers holding a valid pending_token.
  const factorAllowed = await checkRateLimit(`2fa:factor:${factor_id}`, { max: 5, windowSecs: 900 });
  if (!factorAllowed) {
    log.warn('2fa rate limit (factor)', { factor_id, ip: getClientIp(req) }, 'Auth');
    return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' } });
  }

  let userId: string;
  let email: string;
  try {
    const claims = await verifyToken(pending_token);
    userId = claims.sub;
    email = typeof claims.email === 'string' ? claims.email : '';
  } catch {
    return res.status(401).json({ success: false, error: { code: 'INVALID_PENDING_TOKEN', message: 'Pending session expired' } });
  }

  const ip = getClientIp(req);
  if (email) {
    const lockout = await checkLockout(email, ip);
    if (lockout.locked) {
      res.setHeader('Retry-After', String(lockout.retryAfterSecs));
      log.warn('2fa blocked by lockout', { email, ip, retryAfter: lockout.retryAfterSecs }, 'Auth');
      return res.status(423).json({
        success: false,
        error: { code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again later.' },
      });
    }
  }

  try {
    const challengeId = await challengeFactor(factor_id, pending_token);
    const aal2 = await verifyFactor(factor_id, challengeId, code, pending_token);

    const memberships = await sql<{ company_id: string }>`
      SELECT company_id
      FROM company_users
      WHERE user_id = ${userId}
      ORDER BY is_default DESC, created_at ASC
      LIMIT 1
    `;

    setAuthCookies(res, {
      accessToken: aal2.access_token,
      refreshToken: aal2.refresh_token,
      expiresIn: aal2.expires_in,
    });
    if (memberships.length > 0) setActiveCompanyCookie(res, memberships[0]!.company_id);
    clearPendingMfaCookie(res);
    if (email) await clearLockout(email, ip);

    return res.status(200).json({
      success: true,
      data: {
        user: { id: userId, email },
        activeCompanyId: memberships[0]?.company_id ?? null,
      },
    });
  } catch (err) {
    if (err instanceof GotrueMfaError) {
      // TOTP brute-force attempt counts as a failed auth. Only record when
      // it's a credential-class failure (422 invalid code / 401 unauthorized);
      // treat other statuses as upstream errors, not attacker activity.
      const isAttackSignal = err.status === 422 || err.status === 401;
      if (isAttackSignal && email) {
        const failure = await recordFailure(email, ip);
        if (failure.locked) {
          res.setHeader('Retry-After', String(failure.retryAfterSecs));
          log.warn('account locked from 2fa', { email, ip, retryAfter: failure.retryAfterSecs }, 'Auth');
          return res.status(423).json({
            success: false,
            error: { code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again later.' },
          });
        }
      }
      log.info('2fa-challenge failed', { status: err.status }, 'Auth');
      return res.status(err.status === 422 ? 400 : err.status).json({
        success: false,
        error: { code: err.status === 422 ? 'INVALID_CODE' : 'CHALLENGE_FAILED', message: 'Invalid verification code' },
      });
    }
    throw err;
  }
};

export default withRateLimit(handler, { max: 20, windowSecs: 900 });
