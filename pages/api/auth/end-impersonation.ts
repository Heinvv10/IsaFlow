// pages/api/auth/end-impersonation.ts
// Restores the admin's stashed session cookies; deletes the stash row.
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
import { adminRevokeAllUserSessions, logout, verifyTokenSignature } from '@/lib/auth/gotrue';
import { verifyCsrf } from '@/lib/auth/csrf';
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
  try {
    // Restoring the owned admin stash must work even when the target needs MFA.
    // The restored session is subject to the normal completed-session gate.
    const claims = await verifyTokenSignature(accessToken);
    callerId = claims.sub;
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

  // The impersonated GoTrue session outlives the stash and the delegation proof:
  // its refresh token would keep minting access tokens that nothing marks as
  // impersonated. Kill it BEFORE restoring the admin, and keep the stash so a
  // GoTrue outage leaves a retryable exit rather than a live orphan session.
  // scope=local revokes only the presented (impersonated) session, so the member's
  // own sessions survive; when the caller is the admin we no longer hold that
  // token and must fall back to revoking the target's sessions globally.
  // The session that was impersonated, taken from the record the impersonation route
  // wrote for THIS stash. The caller's own claims are the admin's restored session on the
  // global path, and it is this id that stops the delegation proof - so reading it from
  // the caller would leave the proof alive exactly where the exit failed.
  const started = await sql<{ target_session_id: string | null }>`
    SELECT details->>'target_session_id' AS target_session_id FROM admin_audit_log
    WHERE action = 'impersonation_start' AND target_type = 'user'
      AND target_id::text = ${stash.target_user_id} AND details->>'stash_id' = ${stashId}
    ORDER BY created_at DESC LIMIT 1
  `;
  const targetSessionId = started[0]?.target_session_id ?? null;

  const revocationScope = callerId === stash.target_user_id ? 'local' : 'global';

  // The end is recorded BEFORE GoTrue is asked to revoke. That row is what stops the
  // delegation proof; if it were written after, a revocation that succeeded followed by a
  // failed INSERT would leave a revoked session whose still-valid access token keeps
  // passing the proof branch for up to an hour. If this INSERT fails, nothing has been
  // revoked and the impersonation simply continues - the pre-exit state, retryable.
  await sql`
    INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, details)
    VALUES (
      ${stash.admin_user_id},
      'impersonation_end',
      'user',
      ${stash.target_user_id},
      ${JSON.stringify({ stash_id: stashId, target_session_id: targetSessionId, scope: revocationScope })}::jsonb
    )
  `;

  try {
    if (revocationScope === 'local') await logout(accessToken, 'local');
    else await adminRevokeAllUserSessions(stash.target_user_id);
  } catch (revokeErr) {
    log.error('end-impersonation: impersonated session revocation failed',
      { stashId, message: revokeErr instanceof Error ? revokeErr.message : String(revokeErr) }, 'Admin');
    // The end is already on record (above), so the proof is dead; this row says the
    // revocation itself did not happen. The stash stays for the retry.
    await sql`
      INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, details)
      VALUES (${stash.admin_user_id}, 'impersonation_end_failed', 'user', ${stash.target_user_id},
        ${JSON.stringify({ stash_id: stashId, target_session_id: targetSessionId,
          reason: revokeErr instanceof Error ? revokeErr.message : String(revokeErr) })}::jsonb)
    `;
    return res.status(502).json({ success: false,
      error: { code: 'REVOCATION_FAILED', message: 'Could not revoke the impersonated session — please retry' } });
  }

  setAuthCookies(res, {
    accessToken: stash.admin_access_token,
    refreshToken: stash.admin_refresh_token,
    expiresIn: 3600,
  });

  const memberships = await sql<{ company_id: string }>`
    SELECT company_id FROM company_users
    WHERE user_id = ${stash.admin_user_id}
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1
  `;
  if (memberships.length > 0) setActiveCompanyCookie(res, memberships[0]!.company_id);

  clearImpersonationCookies(res);

  await deleteStash(stashId);

  log.info('impersonation ended', { admin: stash.admin_user_id, target: stash.target_user_id }, 'Admin');

  // A global revocation signs the member out of every device they own, not just the
  // impersonated session. The caller is told so it can be shown rather than discovered.
  return res.status(200).json({ success: true, data: { redirect: '/admin',
    revokedScope: revocationScope,
    warning: revocationScope === 'global'
      ? 'Your own session had already replaced the impersonated one, so every session belonging to that user was signed out.'
      : undefined } });
};

export default handler;
