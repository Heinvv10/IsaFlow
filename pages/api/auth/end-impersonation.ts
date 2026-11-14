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
// committed FIRST; then the Login-as session is revoked at GoTrue when this
// request holds its token (scope=local), the stash goes and expired ones are
// purged; only then is a cookie set. If the audit row cannot be written the
// request throws (500) before anything irreversible: no revocation, no stash
// removed, no Set-Cookie, so a retry still works. The revocation outcome is
// added to the row (`target_session_revoked`: true / false / null when this
// browser holds no Login-as token to revoke). A refused restore (no access
// cookie, an unverifiable token, an expired stash) still ends what it can.
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
import { impersonationPartiesOf } from '@/lib/auth/impersonationSessions';
import {
  noteLoginAsEnd, purgeExpiredStashesBestEffort, recordLoginAsEnd, removeLoginAsStashes, revokeLoginAsSession,
  type LoginAsParties,
} from '@/lib/auth/loginAsRecord';
import { verifyCsrf } from '@/lib/auth/csrf';
import { pickInitialCompanyId } from '@/lib/auth/liveCompanies';
import { log } from '@/lib/logger';

/**
 * A refused restore still ends the Login-as. Whose: the session record of a verified Login-as token (its session
 * is then revoked), else the stash row the cookie names, when the caller is one of its parties or presents no
 * verifiable identity at all (its cookie is cleared below, so its row must not outlive it). Nothing to end: null.
 */
async function endRefusedLoginAs(
  stashId: string, accessToken: string | undefined, claims: GoTrueClaims | null, reason: string,
): Promise<void> {
  const sessionParties = accessToken && typeof claims?.session_id === 'string'
    ? await impersonationPartiesOf(claims.session_id) : null;
  let parties: LoginAsParties | null = sessionParties;
  if (!parties) {
    const stashed = await stashPartiesOf(stashId);
    const callerMayEnd = !claims || claims.sub === stashed?.adminUserId || claims.sub === stashed?.targetUserId;
    parties = stashed && callerMayEnd ? { actorUserId: stashed.adminUserId, targetUserId: stashed.targetUserId } : null;
  }
  if (!parties) return;
  const endId = await recordLoginAsEnd(parties, { reason, stash_id: stashId });
  const revoked = sessionParties && accessToken ? await revokeLoginAsSession(accessToken, reason) : null;
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
  if (!accessToken) {
    await endRefusedLoginAs(stashId, undefined, null, 'no_session_cookie');
    return refuse(res, 401, 'UNAUTHORIZED', 'Authentication required', false);
  }

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
    await endRefusedLoginAs(stashId, undefined, null, 'invalid_token');
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
  // Login-as minted may. The record cannot be deleted by a browser (R-032); a lookup failure throws and restores nothing.
  const parties = callerId === stash.target_user_id && typeof sessionId === 'string'
    ? await impersonationPartiesOf(sessionId)
    : null;
  if (callerId === stash.target_user_id
    && (parties?.actorUserId !== stash.admin_user_id || parties.targetUserId !== stash.target_user_id)) {
    log.warn('end-impersonation refused: not the Login-as session', { callerId, stashAdmin: stash.admin_user_id }, 'Admin');
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not authorised to end this impersonation' } });
  }

  // Recorded first: a failed write throws here, before any revocation, removal or cookie.
  const endId = await recordLoginAsEnd(
    { actorUserId: stash.admin_user_id, targetUserId: stash.target_user_id }, { stash_id: stashId });

  // The caller is the Login-as session (checked above): end it at GoTrue too. Its own token names it (scope=local).
  // When the caller is the admin, this browser no longer holds the target session's token: nothing to revoke here.
  const targetSessionRevoked = callerId === stash.target_user_id ? await revokeLoginAsSession(accessToken, 'end') : null;
  await noteLoginAsEnd(endId, { target_session_revoked: targetSessionRevoked });

  await deleteStash(stashId);
  await purgeExpiredStashesBestEffort('end-impersonation');

  // Returning to the admin's own session: only a company withAuth will still
  // admit (src/lib/auth/liveCompanies.ts), so ending an impersonation cannot
  // drop the admin into a soft-deleted tenant that 403s everything.
  const adminCompanyId = await pickInitialCompanyId(stash.admin_user_id);

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
