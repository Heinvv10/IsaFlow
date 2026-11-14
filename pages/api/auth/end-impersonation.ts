// pages/api/auth/end-impersonation.ts
// Restores the admin's stashed session cookies; deletes the stash row.
//
// Auth model: the caller MUST either (a) still be authenticated as the
// impersonated target user (normal flow), or (b) already be authenticated as
// the admin who started impersonation (if they previously cleared cookies).
// The stash UUID alone is not sufficient — pentest C1.
//
// Every way out ends the Login-as (admin audit 2026-11-14, 3.10), in this order
// (src/lib/auth/loginAsRecord.ts): the `impersonation_end` row is written and
// committed FIRST; then the stash goes, then the Login-as session is revoked
// at GoTrue when this request holds its token (scope=local) and expired
// stashes are purged; only then is a cookie set. If the audit row cannot be written the
// request throws (500) before anything irreversible: no revocation, no stash
// removed, no Set-Cookie, so a retry still works. The revocation outcome is
// added to the row (`target_session_revoked`: true / false / null when this
// browser holds no Login-as token to revoke). A refused restore (no access
// cookie, an unverifiable token, an expired stash) clears this browser's cookies;
// only a VERIFIED caller's expired stash is ended (revoked, removed, audited).
// The end row is one per stash: a retry reuses it (loginAsRecord.recordLoginAsEnd).
import type { NextApiHandler, NextApiResponse } from 'next';
import {
  parseCookies,
  setAuthCookies,
  setActiveCompanyCookie,
  clearAuthCookies,
  ACCESS_COOKIE,
} from '@/lib/auth/cookies';
import { ADMIN_STASH_COOKIE, clearImpersonationCookies } from '@/lib/auth/impersonation-cookies';
import { loadStash, deleteStash, stashPartiesOf } from '@/modules/admin/services/userImpersonationService';
import { verifyTokenSignature, type GoTrueClaims } from '@/lib/auth/gotrue';
import { impersonationPartiesOfBounded } from '@/lib/auth/impersonationSessions';
import {
  noteLoginAsEnd, purgeExpiredStashesBestEffort, recordLoginAsEnd, removeLoginAsStashes, revokeLoginAsSession,
  type LoginAsParties,
} from '@/lib/auth/loginAsRecord';
import { cappedLoginAsLookup } from '@/lib/auth/loginAsLookup';
import { verifyCsrf } from '@/lib/auth/csrf';
import { pickInitialCompanyId } from '@/lib/auth/liveCompanies';
import { log } from '@/lib/logger';

/**
 * The session record of a verified token, bounded (impersonationPartiesOfBounded: this route is reachable without
 * a live session, so it must never hold or wait long for a platform_admin slot). `gave_up` when the look-up failed
 * or passed its bound (logged).
 */
async function partiesOfSession(sessionId: unknown): Promise<LoginAsParties | null | 'gave_up'> {
  if (typeof sessionId !== 'string') return null;
  try {
    return await impersonationPartiesOfBounded(sessionId);
  } catch (err) {
    log.warn('end-impersonation: session record look-up failed or timed out',
      { message: err instanceof Error ? err.message : String(err) }, 'Admin');
    return 'gave_up';
  }
}

/**
 * An expired stash, refused, still ends the Login-as for a VERIFIED caller, and never does nothing (#1371 security
 * review). Never called without verified claims (re-break N2: an unauthenticated request writes nothing in an
 * admin's name, it only clears its own cookies).
 *  1. The stash row the cookie names is read first (migration pool, primary key: no platform_admin slot). Not the
 *     caller's, or gone (a junk cookie, a retry after a lost answer): no look-up and no row in anyone's name; the
 *     browser is signed out (the caller clears its cookies), so its own session is revoked too.
 *  2. Only then is a slot of the capped look-up taken (loginAsLookup, shared with Sign Out), so junk stash cookies
 *     cannot starve real ends. Skipped by the cap or past its bound: the end is still recorded, keyed on the verified
 *     stash, the caller's own session is revoked, the stash removed, and a warning logged.
 *  3. Otherwise the session record decides whose Login-as this is (its session is revoked), else the stash's.
 */
async function endRefusedLoginAs(stashId: string, accessToken: string, claims: GoTrueClaims, reason: string): Promise<void> {
  const stashed = await stashPartiesOf(stashId);
  if (!stashed || (claims.sub !== stashed.adminUserId && claims.sub !== stashed.targetUserId)) {
    const revoked = await revokeLoginAsSession(accessToken, reason);
    log.info('end-impersonation: no stash of the caller to end; its own session revoked', { revoked }, 'Admin');
    return;
  }
  const stashParties: LoginAsParties = { actorUserId: stashed.adminUserId, targetUserId: stashed.targetUserId };
  const lookup = typeof claims.session_id === 'string'
    ? await cappedLoginAsLookup(claims.session_id, 'end-impersonation') : null;
  if (lookup === 'skipped' || lookup === 'gave_up') {
    log.warn('end-impersonation: Login-as look-up unavailable; ending by the verified stash and the own session',
      { lookup }, 'Admin');
    const endId = await recordLoginAsEnd(stashParties, { stashId }, { reason, lookup });
    const callerRevoked = await revokeLoginAsSession(accessToken, reason);
    const stashesRemoved = await removeLoginAsStashes(stashParties, stashId, reason);
    await noteLoginAsEnd(endId, { caller_session_revoked: callerRevoked, stashes_removed: stashesRemoved });
    return;
  }
  const sessionParties = lookup;
  const parties: LoginAsParties = sessionParties ?? stashParties;
  // The end row's key is what the server verified (security review, #1371): the session record behind this token,
  // and the stash id only when that stash row is these parties'.
  const stashVerified = stashed.adminUserId === parties.actorUserId && stashed.targetUserId === parties.targetUserId;
  const endId = await recordLoginAsEnd(parties, {
    sessionId: sessionParties ? String(claims.session_id) : undefined,
    stashId: stashVerified ? stashId : undefined,
  }, { reason });
  const revoked = sessionParties ? await revokeLoginAsSession(accessToken, reason) : null;
  const stashesRemoved = await removeLoginAsStashes(parties, stashId, reason);
  await noteLoginAsEnd(endId, { target_session_revoked: revoked, stashes_removed: stashesRemoved });
}

function refuse(res: NextApiResponse, status: number, code: string, message: string, clearAuth: boolean) {
  if (clearAuth) clearAuthCookies(res);
  clearImpersonationCookies(res);
  return res.status(status).json({ success: false, error: { code, message } });
}

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }

  if (!verifyCsrf(req)) {
    return res.status(403).json({ success: false, error: { code: 'CSRF_MISMATCH', message: 'CSRF token mismatch' } });
  }

  const cookies = parseCookies(req);
  const stashId = cookies[ADMIN_STASH_COOKIE];
  if (!stashId) {
    return res.status(400).json({ success: false, error: { code: 'NOT_IMPERSONATING', message: 'No active impersonation' } });
  }

  const accessToken = cookies[ACCESS_COOKIE];
  // No verifiable identity (no access cookie here, a bad token below): only this browser's own cookies are cleared.
  // Nothing is deleted or recorded in an admin's name on a stash id alone (#1371 re-break N2); the stash is
  // unusable without the cookie, expires within 1 h, and the next Login-as start or end purges it.
  if (!accessToken) return refuse(res, 401, 'UNAUTHORIZED', 'Authentication required', false);

  // DELIBERATELY UNGATED for account standing — this is not an oversight.
  //
  // Every other verifyToken() caller consults `requireActiveAccount` (see
  // src/lib/auth/userAccountStatus.ts). This one must not, because `callerId`
  // here is the IMPERSONATED TARGET, not the admin. The realistic sequence is
  // an admin impersonating a user to investigate, then suspending them —
  // gating on the caller would strand that admin holding a suspended user's
  // cookies with no route back to their own session.
  //
  // Nothing is lost by allowing it: this endpoint only restores the admin's
  // stashed session, and that restored session is itself gated by withAuth and
  // withPlatformAdmin. The other end is closed too — userImpersonationService
  // refuses to START impersonation of an inactive target (TARGET_INACTIVE).
  let claims: GoTrueClaims;
  try {
    // Restoring the owned admin stash must work even when the target needs MFA.
    // The restored session is subject to the normal completed-session gate.
    claims = await verifyTokenSignature(accessToken);
  } catch {
    return refuse(res, 401, 'INVALID_TOKEN', 'Invalid or expired token', true);
  }
  const callerId = claims.sub;
  const sessionId = claims.session_id;

  const stash = await loadStash(stashId);
  if (!stash) {
    await endRefusedLoginAs(stashId, accessToken, claims, 'stash_expired');
    return refuse(res, 401, 'STASH_EXPIRED', 'Impersonation expired — please log in again', true);
  }

  if (callerId !== stash.target_user_id && callerId !== stash.admin_user_id) {
    log.warn('end-impersonation ownership mismatch', {
      callerId,
      stashAdmin: stash.admin_user_id,
      stashTarget: stash.target_user_id,
    }, 'Admin');
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not authorised to end this impersonation' } });
  }

  // The stash holds the admin's tokens, so a target's own session may not spend it: only the session this admin's
  // Login-as minted may. The record cannot be deleted by a browser (R-032). A look-up that fails or passes its bound
  // restores nothing: 503, cookies kept, so a retry can still restore.
  const parties = callerId === stash.target_user_id ? await partiesOfSession(sessionId) : null;
  if (parties === 'gave_up') {
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Could not end the impersonation right now. Try again.' } });
  }
  if (callerId === stash.target_user_id
    && (parties?.actorUserId !== stash.admin_user_id || parties.targetUserId !== stash.target_user_id)) {
    log.warn('end-impersonation refused: not the Login-as session', { callerId, stashAdmin: stash.admin_user_id }, 'Admin');
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not authorised to end this impersonation' } });
  }

  // Recorded first: a failed write throws here, before any removal, revocation or cookie. The stash goes next,
  // before the revocation: a failure after this point leaves no live stash to restore from, so a retry takes the
  // STASH_EXPIRED path, which revokes what it holds and records that end too (the truth, not a second restore).
  // Every fallible read happens before the first irreversible step (record, stash delete, revoke): a failure here is
  // a 500 with the stash still live, so a retry restores. Returning to the admin's own session: only a company
  // withAuth will still admit (src/lib/auth/liveCompanies.ts), so ending an impersonation cannot drop the admin
  // into a soft-deleted tenant that 403s everything.
  const adminCompanyId = await pickInitialCompanyId(stash.admin_user_id);

  // Keyed on the stash just loaded for these parties and, for the Login-as session itself, its verified session id.
  const endId = await recordLoginAsEnd(
    { actorUserId: stash.admin_user_id, targetUserId: stash.target_user_id },
    { stashId: String(stash.stash_id), sessionId: parties ? String(sessionId) : undefined }, {});
  await deleteStash(stashId);

  // The caller is the Login-as session (checked above): end it at GoTrue too. Its own token names it (scope=local).
  // When the caller is the admin, this browser no longer holds the target session's token: nothing to revoke here.
  const targetSessionRevoked = callerId === stash.target_user_id ? await revokeLoginAsSession(accessToken, 'end') : null;
  await noteLoginAsEnd(endId, { target_session_revoked: targetSessionRevoked });
  await purgeExpiredStashesBestEffort('end-impersonation');

  setAuthCookies(res, {
    accessToken: stash.admin_access_token,
    refreshToken: stash.admin_refresh_token,
    expiresIn: 3600,
    persistent: false, // Login-as overwrote the admin's "Keep me signed in" hint: unknown counts as not ticked
  });
  if (adminCompanyId) setActiveCompanyCookie(res, adminCompanyId);
  clearImpersonationCookies(res);

  log.info('impersonation ended', { admin: stash.admin_user_id, target: stash.target_user_id, targetSessionRevoked }, 'Admin');

  return res.status(200).json({ success: true, data: { redirect: '/admin' } });
};

export default handler;
