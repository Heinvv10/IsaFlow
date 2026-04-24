// pages/api/auth/login.ts
import type { NextApiHandler } from 'next';
import { signIn } from '@/lib/auth/gotrue';
import { listFactors, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { setAuthCookies, setActiveCompanyCookie, setPendingMfaCookie } from '@/lib/auth/cookies';
import { checkLockout, recordFailure, clearLockout } from '@/lib/auth/accountLockout';
import { checkRateLimit, getClientIp, withRateLimit } from '@/lib/rateLimit';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'email and password required' } });
  }

  const cleanEmail = email.toLowerCase().trim();
  const ip = getClientIp(req);

  const lockout = await checkLockout(cleanEmail, ip);
  if (lockout.locked) {
    res.setHeader('Retry-After', String(lockout.retryAfterSecs));
    log.warn('login blocked by lockout', { email: cleanEmail, ip, retryAfter: lockout.retryAfterSecs }, 'Auth');
    return res.status(423).json({
      success: false,
      error: { code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again later.' },
    });
  }

  const emailAllowed = await checkRateLimit(`login:email:${cleanEmail}`, { max: 10, windowSecs: 900 });
  if (!emailAllowed) {
    log.warn('login rate limit (email)', { email: cleanEmail, ip }, 'Auth');
    return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' } });
  }

  let token;
  try {
    token = await signIn(cleanEmail, password);
  } catch (err) {
    const failure = await recordFailure(cleanEmail, ip);
    log.info('login failed', { email, message: err instanceof Error ? err.message : 'unknown', locked: failure.locked }, 'Auth');
    if (failure.locked) {
      res.setHeader('Retry-After', String(failure.retryAfterSecs));
      log.warn('account locked', { email: cleanEmail, ip, retryAfter: failure.retryAfterSecs }, 'Auth');
      return res.status(423).json({
        success: false,
        error: { code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again later.' },
      });
    }
    return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
  }

  // MFA gate: if the user has any verified factor, withhold cookies and ask for a code.
  // Fail-closed on GoTrue error per spec — do not silently log in.
  let verified;
  try {
    const factors = await listFactors(token.access_token);
    verified = factors.totp.filter((f) => f.status === 'verified');
  } catch (err) {
    log.error('login: listFactors failed — failing closed', { message: err instanceof Error ? err.message : 'unknown' }, 'Auth');
    if (err instanceof GotrueMfaError) {
      return res.status(503).json({ success: false, error: { code: 'MFA_CHECK_UNAVAILABLE', message: 'Sign-in temporarily unavailable. Please try again.' } });
    }
    return res.status(503).json({ success: false, error: { code: 'MFA_CHECK_UNAVAILABLE', message: 'Sign-in temporarily unavailable. Please try again.' } });
  }

  if (verified.length > 0) {
    // Pentest H6: pending_token is now a short-lived HttpOnly cookie.
    // Returning it in the response body exposes it to XSS / extensions.
    setPendingMfaCookie(res, token.access_token);
    return res.status(200).json({
      success: true,
      data: {
        requires_2fa: true,
        factor_id: verified[0]!.id,
      },
    });
  }

  // No MFA — set cookies and sign in directly.
  await clearLockout(cleanEmail, ip);
  const memberships = await sql<{ company_id: string; is_default: boolean; created_at: Date }>`
    SELECT company_id, is_default, created_at
    FROM company_users
    WHERE user_id = ${token.user.id}
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1
  `;

  setAuthCookies(res, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresIn: token.expires_in,
  });
  if (memberships.length > 0) setActiveCompanyCookie(res, memberships[0]!.company_id);

  return res.status(200).json({
    success: true,
    data: {
      user: { id: token.user.id, email: token.user.email },
      activeCompanyId: memberships[0]?.company_id ?? null,
    },
  });
};

export default withRateLimit(handler, { max: 20, windowSecs: 900 });
