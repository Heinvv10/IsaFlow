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
import { refresh } from '@/lib/auth/gotrue';
import {
  setAuthCookies,
  clearAuthCookies,
  parseCookies,
  REFRESH_COOKIE,
  REMEMBER_ME_COOKIE,
} from '@/lib/auth/cookies';
import { withRateLimit } from '@/lib/rateLimit';
import { requireActiveAccount } from '@/lib/auth/requireActiveAccount';
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

  // Preserve the original "Keep me signed in" choice by reading the hint cookie.
  // Default to true: a session-cookie user whose browser is still open clearly
  // wants the session to continue; the rotated refresh cookie behaves the same
  // way as the original (session-only when hint = '0', persistent otherwise).
  const persistent = cookies[REMEMBER_ME_COOKIE] !== '0';

  setAuthCookies(res, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresIn: token.expires_in,
    persistent,
  });

  return res.status(200).json({
    success: true,
    data: {
      expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    },
  });
};

// 30 refresh attempts per minute per IP — generous for legit multi-tab refresh
// storms, tight enough to bound brute-forcing of stolen-but-stale refresh tokens.
export default withRateLimit(handler, { max: 30, windowSecs: 60 }, 'auth-refresh');
