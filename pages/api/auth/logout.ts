// pages/api/auth/logout.ts
import type { NextApiHandler } from 'next';
import { isSessionAlreadyGone, logout as gotrueLogout, refresh, verifyTokenSignature } from '@/lib/auth/gotrue';
import { parseCookies, clearAuthCookies, ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/auth/cookies';
import { ADMIN_STASH_COOKIE } from '@/lib/auth/impersonation-cookies';
import { endLoginAsWithoutRestore, type LoginAsSession } from '@/lib/auth/loginAsRecord';
import { cappedLoginAsLookup } from '@/lib/auth/loginAsLookup';
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
    catch (err) {
      if (isSessionAlreadyGone(err)) return accessToken; // already revoked: ended, nothing to renew
      noteFailure(err);
    }
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
 * The Login-as session `token` names, or null. A look-up slot (loginAsLookup.cappedLoginAsLookup: global and
 * per-session caps, shared with end-impersonation) is taken only by a Sign Out that could be a Login-as: a stash
 * cookie is present, and the access token's signature verifies (locally, no DB) and carries a `session_id`. Junk,
 * token-less and stash-less Sign Outs never take one. (The JWT carries no Login-as marker; the session record is
 * the only proof, which is what the look-up reads.) Skipped, failed or past its bound: null, logged there; Sign Out
 * goes ahead, revoking with the caller's own token and clearing the cookies. Never a 429.
 */
async function loginAsPartiesOrNull(token: string | undefined, stashId: string | undefined): Promise<LoginAsSession | null> {
  if (!token || !stashId) return null;
  let sessionId: unknown;
  try {
    sessionId = (await verifyTokenSignature(token)).session_id;
  } catch {
    return null; // expired or not ours: it names no session, nothing to close
  }
  if (typeof sessionId !== 'string') return null;
  const parties = await cappedLoginAsLookup(sessionId, 'logout');
  return parties && parties !== 'skipped' && parties !== 'gave_up' ? { ...parties, sessionId } : null;
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
  const parties = await loginAsPartiesOrNull(access, stashId);
  if (parties) {
    await endLoginAsWithoutRestore({ parties, stashId, reason: 'logout',
      revoke: async () => (await endThisSession(access, refreshToken)) !== undefined });
  } else {
    const ended = await endThisSession(access, refreshToken);
    // An expired access token names no session until the refresh renewed it: recorded after the revocation.
    const late = ended && ended !== access ? await loginAsPartiesOrNull(ended, stashId) : null;
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
