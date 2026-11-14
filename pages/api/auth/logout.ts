// pages/api/auth/logout.ts
import type { NextApiHandler } from 'next';
import { logout as gotrueLogout, refresh, verifyTokenSignature } from '@/lib/auth/gotrue';
import { parseCookies, clearAuthCookies, ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/auth/cookies';
import { ADMIN_STASH_COOKIE } from '@/lib/auth/impersonation-cookies';
import { createHash } from 'node:crypto';
import { endLoginAsWithoutRestore, type LoginAsSession } from '@/lib/auth/loginAsRecord';
import { impersonationPartiesOfBounded } from '@/lib/auth/impersonationSessions';
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
 * At most this many Sign Outs run the Login-as look-up at once, process-wide (security review, #1371): Sign Out
 * is unauthenticated and not rate limited, so without a cap a burst could hold every platform_admin slot.
 * A slot is taken only by a Sign Out that could be a Login-as: a stash cookie is present, and the access token's
 * signature verifies (locally, no DB) and carries a `session_id`. Junk, token-less and stash-less Sign Outs never
 * take one. (The JWT itself carries no Login-as marker; the session record is the only proof, which is what the
 * look-up reads.) Over the cap the look-up is skipped and logged at warn with a hash of the session id; the session
 * is still revoked at GoTrue with the caller's own token and the cookies still clear. Never a 429.
 * Residual, accepted: a skipped Login-as leaves its stash row, unusable without the cleared cookie, to expire within
 * 1 h (purged by the next Login-as start or end); only a flood of VALID Login-as tokens could keep the cap full.
 */
export const SIGN_OUT_LOOKUP_SLOTS = 2;
let lookupsInFlight = 0;

const sessionTag = (sessionId: string) => createHash('sha256').update(sessionId).digest('hex').slice(0, 12);

/**
 * The Login-as session `token` names, or null: no stash cookie (nothing to close), a token that does not verify
 * or names no session, an ordinary session, the cap reached, or a look-up that failed or gave up within its
 * bound (logged; Sign Out goes ahead).
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
  if (lookupsInFlight >= SIGN_OUT_LOOKUP_SLOTS) {
    log.warn('logout: Login-as look-up skipped (concurrency cap); signing out without closing it',
      { session: sessionTag(sessionId) }, 'Auth');
    return null;
  }
  lookupsInFlight += 1;
  try {
    const parties = await impersonationPartiesOfBounded(sessionId);
    return parties ? { ...parties, sessionId } : null;
  } catch (err) {
    log.warn('logout: Login-as session record lookup failed or timed out; signing out without closing it',
      { session: sessionTag(sessionId), message: err instanceof Error ? err.message : String(err) }, 'Auth');
    return null;
  } finally {
    lookupsInFlight -= 1;
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
