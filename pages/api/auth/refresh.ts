// pages/api/auth/refresh.ts
// PRD-10 Layer 1: rotates the access cookie using the long-lived refresh cookie.
// Called automatically by:
//   - the apiFetch 401-retry interceptor (src/lib/apiFetch.ts)
//   - the session heartbeat every 50 minutes (src/lib/auth/sessionHeartbeat.ts)
//
// Intentional design decisions:
//   - Not wrapped with withAuth — the access token is presumed expired.
//   - Not wrapped with withCsrf — the refresh cookie itself is the credential,
//     and adding CSRF would block the heartbeat from running cross-tab.
//   - Rate-limited per IP (refresh tokens are scoped to the browser, so per-IP
//     bounding is the right granularity before we know who the caller is).
import type { NextApiHandler } from 'next';
import { refresh, verifyTokenSignature } from '@/lib/auth/gotrue';
import { AUTH_RETRY_AFTER_SECS, AUTH_UNAVAILABLE_ERROR, respondIfAuthUnavailable } from '@/lib/auth/authUpstream';
import {
  setAuthCookies,
  clearAuthCookies,
  parseCookies,
  REFRESH_COOKIE,
  REMEMBER_ME_COOKIE,
} from '@/lib/auth/cookies';
import { withRateLimit } from '@/lib/rateLimit';
import { requireActiveAccount } from '@/lib/auth/requireActiveAccount';
import { endExpiredLoginAs } from '@/lib/auth/endExpiredLoginAs';
import { proofSecondsLeft, validateImpersonationProof } from '@/lib/auth/impersonationAssurance';
import { ADMIN_STASH_COOKIE, IMPERSONATION_PROOF_COOKIE } from '@/lib/auth/impersonation-cookies';
import { sessionActorOfToken } from '@/lib/auth/impersonationSessions';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res
      .status(405)
      .json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }

  const cookies = parseCookies(req);
  const refreshToken = cookies[REFRESH_COOKIE];
  if (!refreshToken) {
    return res
      .status(401)
      .json({ success: false, error: { code: 'NO_REFRESH_TOKEN', message: 'No active session to refresh' } });
  }

  let token;
  try {
    token = await refresh(refreshToken);
  } catch (err) {
    // D9: GoTrue could not answer. The refresh token may still be good: keep the cookies.
    if (respondIfAuthUnavailable(res, err, 'auth refresh')) return;
    log.info(
      'auth refresh failed — clearing cookies',
      { message: err instanceof Error ? err.message : 'unknown' },
      'Auth',
    );
    clearAuthCookies(res);
    return res
      .status(401)
      .json({ success: false, error: { code: 'REFRESH_FAILED', message: 'Session expired. Please sign in.' } });
  }

  // Account-standing gate. refresh renews a session indefinitely, so without
  // this a suspended user whose GoTrue revocation failed (suspendUser warns
  // about exactly that case) keeps a live session forever. Checking here makes
  // suspension self-healing: the next refresh closes the session for good.
  //
  // Cookies are cleared on refusal so the browser stops retrying rather than
  // looping against a 403 every 50 minutes via the session heartbeat.
  const refusal = await requireActiveAccount(token.user.id);
  if (refusal) {
    log.warn('auth refresh refused — account not in good standing', { userId: token.user.id }, 'Auth');
    clearAuthCookies(res);
    return res.status(403).json({ success: false, error: refusal });
  }

  // A Login-as session is time-boxed by its proof, but its refresh cookie lasts 30
  // days: without this, a later page load could renew it long after the box ended.
  // A renewal inside the box gets a cookie that dies with the proof. GoTrue sets the
  // JWT's own lifetime, so a copy of that one token stays valid until its exp.
  let expiresIn = token.expires_in;
  let actor: Awaited<ReturnType<typeof sessionActorOfToken>>;
  try {
    actor = await sessionActorOfToken(token.access_token);
  } catch (err) {
    // No verdict on the session: keep the cookies. GoTrue accepts the old refresh token again on the retry.
    log.error('auth refresh: session lookup failed', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
    res.setHeader('Retry-After', String(AUTH_RETRY_AFTER_SECS));
    return res.status(503).json({ success: false, error: AUTH_UNAVAILABLE_ERROR });
  }
  if (actor === 'impersonation') {
    const proof = cookies[IMPERSONATION_PROOF_COOKIE];
    if (!proof || !(await validateImpersonationProof(proof, await verifyTokenSignature(token.access_token)))) {
      log.info('auth refresh refused: Login-as session has outlived its proof', { userId: token.user.id }, 'Auth');
      await endExpiredLoginAs(res, token.access_token, cookies[ADMIN_STASH_COOKIE]);
      return res
        .status(401)
        .json({ success: false, error: { code: 'REFRESH_FAILED', message: 'Session expired. Please sign in.' } });
    }
    expiresIn = Math.min(expiresIn, proofSecondsLeft(proof));
  }

  // Preserve the original "Keep me signed in" choice by reading the hint cookie.
  // Unknown counts as not ticked: the rotated cookies are session-only, and the session
  // continues while the browser stays open.
  const persistent = cookies[REMEMBER_ME_COOKIE] === '1';

  setAuthCookies(res, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresIn,
    // A session-only cookie has no Max-Age, so it would ignore the limit set above.
    persistent: actor === 'impersonation' || persistent,
    preserveImpersonation: true,
  });

  return res.status(200).json({
    success: true,
    data: {
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    },
  });
};

// 30 refresh attempts per minute per IP — generous for legit multi-tab refresh
// storms, tight enough to bound brute-forcing of stolen-but-stale refresh tokens.
export default withRateLimit(handler, { max: 30, windowSecs: 60 }, 'auth-refresh');
