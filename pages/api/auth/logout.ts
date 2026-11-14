// pages/api/auth/logout.ts
import type { NextApiHandler } from 'next';
import { logout as gotrueLogout, refresh } from '@/lib/auth/gotrue';
import { parseCookies, clearAuthCookies, ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/auth/cookies';
import { ADMIN_STASH_COOKIE } from '@/lib/auth/impersonation-cookies';
import { endLoginAsWithoutRestore, loginAsPartiesOfToken, type LoginAsParties } from '@/lib/auth/loginAsRecord';
import { log } from '@/lib/logger';
import { withCsrf } from '@/lib/auth/withCsrf';


const noteFailure = (err: unknown) =>
  log.info('gotrue logout non-fatal error', { message: err instanceof Error ? err.message : String(err) }, 'Auth');

/**
 * This browser's session only: the global default would sign the account's other
 * devices out (and, R-032 (f), an impersonated target's own sessions). Revoking every
 * session belongs to password change and reset (sessionRevocation.ts). With the access
 * token gone or expired, the refresh cookie is the only way left to name the session.
 */
async function endThisSession(accessToken?: string, refreshToken?: string): Promise<string | undefined> {
  if (accessToken) {
    try { await gotrueLogout(accessToken, 'local'); return accessToken; }
    catch (err) { noteFailure(err); }
  }
  if (refreshToken) {
    try {
      const renewed = (await refresh(refreshToken)).access_token;
      await gotrueLogout(renewed, 'local');
      return renewed;
    } catch (err) { noteFailure(err); }
  }
  return undefined;
}

/**
 * The Login-as parties `token` names, or null: an ordinary session, a token that names none (expired or not
 * ours), or a look-up that failed or gave up within its bound (logged; Sign Out goes ahead).
 */
async function loginAsPartiesOrNull(token: string | undefined): Promise<LoginAsParties | null> {
  if (!token) return null;
  try {
    return await loginAsPartiesOfToken(token, { bounded: true });
  } catch (err) {
    log.warn('logout: Login-as session record lookup failed or timed out; signing out without closing it',
      { message: err instanceof Error ? err.message : String(err) }, 'Auth');
    return null;
  }
}

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const cookies = parseCookies(req);
  const access = cookies[ACCESS_COOKIE];
  const refreshToken = cookies[REFRESH_COOKIE];
  const stashId = cookies[ADMIN_STASH_COOKIE];
  // A Login-as session signing out (admin audit 2026-11-14, 3.10): the end is recorded before the session is
  // revoked, the admin's stash row goes too (not only its cookie), and the row says whether GoTrue revoked it.
  // Signing out is never refused for a failed audit write (loginAsRecord.endLoginAsWithoutRestore).
  // Limits, accepted: the stash is found by the session record's parties, so a Sign Out whose session cannot be
  // named (an expired access token that GoTrue would not renew, or a look-up past its bound) closes nothing. Its
  // stash row is already unusable (the cookie clears below, and the row is refused by loadStash once it expires,
  // within 1 h of the start) and is purged by the next Login-as start or end.
  // Not rate limited, deliberately (#1371 re-break N1): a limit keyed on the client IP (cloudflared, no real_ip)
  // let one script stop everyone behind that IP from revoking their sessions. The look-up is bounded instead.
  const parties = await loginAsPartiesOrNull(access);
  if (parties) {
    await endLoginAsWithoutRestore({ parties, stashId, reason: 'logout',
      revoke: async () => (await endThisSession(access, refreshToken)) !== undefined });
  } else {
    const ended = await endThisSession(access, refreshToken);
    // An expired access token names no session until the refresh renewed it: recorded after the revocation.
    const late = ended && ended !== access ? await loginAsPartiesOrNull(ended) : null;
    if (late) await endLoginAsWithoutRestore({ parties: late, stashId, reason: 'logout', revoke: async () => true });
    else if (stashId) {
      log.info('logout: a stash cookie but no Login-as session to name; nothing to close (its stash expires within 1 h)',
        {}, 'Auth');
    }
  }
  clearAuthCookies(res);
  return res.status(200).json({ success: true, data: null });
};

export default withCsrf(handler);
