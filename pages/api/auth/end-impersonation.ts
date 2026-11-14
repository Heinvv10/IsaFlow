// pages/api/auth/end-impersonation.ts
// Restores the admin's stashed session cookies; deletes the stash row; revokes
// the Login-as session at GoTrue (admin audit 2026-11-14, 3.10), so a copy of
// its access or refresh token taken before "Return" cannot keep it going. A
// failed revocation does not trap the admin in the target's session: the end
// goes ahead and its audit row says `target_session_revoked: false`. When the
// caller is the admin (case (b) below) this browser no longer holds the target
// session's token, so there is nothing to revoke here: `null`. Expired stash
// rows (any admin's) are purged on the way out.
//
// Auth model: the caller MUST either (a) still be authenticated as the
// impersonated target user (normal flow), or (b) already be authenticated as
// the admin who started impersonation (if they previously cleared cookies).
// The stash UUID alone is not sufficient — pentest C1.
import type { NextApiHandler } from 'next';
import {
  parseCookies,
  setAuthCookies,
  setActiveCompanyCookie,
  clearAuthCookies,
  ACCESS_COOKIE,
} from '@/lib/auth/cookies';
import { ADMIN_STASH_COOKIE, clearImpersonationCookies } from '@/lib/auth/impersonation-cookies';
import { loadStash, deleteStash } from '@/modules/admin/services/userImpersonationService';
import { logout, verifyTokenSignature } from '@/lib/auth/gotrue';
import { purgeExpiredStashesBestEffort } from '@/lib/auth/loginAsRecord';
import { impersonationPartiesOf } from '@/lib/auth/impersonationSessions';
import { verifyCsrf } from '@/lib/auth/csrf';
import { pickInitialCompanyId } from '@/lib/auth/liveCompanies';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

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
    clearImpersonationCookies(res);
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
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
  let callerId: string;
  let sessionId: unknown;
  try {
    // Restoring the owned admin stash must work even when the target needs MFA.
    // The restored session is subject to the normal completed-session gate.
    const claims = await verifyTokenSignature(accessToken);
    callerId = claims.sub;
    sessionId = claims.session_id;
  } catch {
    clearAuthCookies(res);
    clearImpersonationCookies(res);
    return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } });
  }

  const stash = await loadStash(stashId);
  if (!stash) {
    clearAuthCookies(res);
    clearImpersonationCookies(res);
    return res.status(401).json({ success: false, error: { code: 'STASH_EXPIRED', message: 'Impersonation expired — please log in again' } });
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

  // The caller is the Login-as session (checked above): end it at GoTrue too. Its own token names it (scope=local).
  let targetSessionRevoked: boolean | null = null;
  if (callerId === stash.target_user_id) {
    try {
      await logout(accessToken, 'local');
      targetSessionRevoked = true;
    } catch (err) {
      targetSessionRevoked = false;
      log.error('end-impersonation: the Login-as session could not be revoked at GoTrue', {
        admin: stash.admin_user_id, target: stash.target_user_id, message: err instanceof Error ? err.message : String(err),
      }, 'Admin');
    }
  }

  setAuthCookies(res, {
    accessToken: stash.admin_access_token,
    refreshToken: stash.admin_refresh_token,
    expiresIn: 3600,
    persistent: false, // Login-as overwrote the admin's "Keep me signed in" hint: unknown counts as not ticked
  });

  // Returning to the admin's own session: only a company withAuth will still
  // admit (src/lib/auth/liveCompanies.ts), so ending an impersonation cannot
  // drop the admin into a soft-deleted tenant that 403s everything.
  const adminCompanyId = await pickInitialCompanyId(stash.admin_user_id);
  if (adminCompanyId) setActiveCompanyCookie(res, adminCompanyId);

  clearImpersonationCookies(res);

  await sql`
    INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, details)
    VALUES (
      ${stash.admin_user_id},
      'impersonation_end',
      'user',
      ${stash.target_user_id},
      ${JSON.stringify({ stash_id: stashId, target_session_revoked: targetSessionRevoked })}::jsonb
    )
  `;

  await deleteStash(stashId);
  await purgeExpiredStashesBestEffort('end-impersonation');

  log.info('impersonation ended', { admin: stash.admin_user_id, target: stash.target_user_id, targetSessionRevoked }, 'Admin');

  return res.status(200).json({ success: true, data: { redirect: '/admin' } });
};

export default handler;
