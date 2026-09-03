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
import { verifyToken } from '@/lib/auth/gotrue';
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
    const claims = await verifyToken(accessToken);
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

  await sql`
    INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, details)
    VALUES (
      ${stash.admin_user_id},
      'impersonation_end',
      'user',
      ${stash.target_user_id},
      ${JSON.stringify({ stash_id: stashId })}::jsonb
    )
  `;

  await deleteStash(stashId);

  log.info('impersonation ended', { admin: stash.admin_user_id, target: stash.target_user_id }, 'Admin');

  return res.status(200).json({ success: true, data: { redirect: '/admin' } });
};

export default handler;
