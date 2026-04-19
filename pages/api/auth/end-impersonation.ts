// pages/api/auth/end-impersonation.ts
// Restores the admin's stashed session cookies; deletes the stash row.
import type { NextApiHandler } from 'next';
import {
  parseCookies,
  setAuthCookies,
  setActiveCompanyCookie,
  clearAuthCookies,
} from '@/lib/auth/cookies';
import { ADMIN_STASH_COOKIE, clearImpersonationCookies } from '@/lib/auth/impersonation-cookies';
import { loadStash, deleteStash } from '@/modules/admin/services/userImpersonationService';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }

  const stashId = parseCookies(req)[ADMIN_STASH_COOKIE];
  if (!stashId) {
    return res.status(400).json({ success: false, error: { code: 'NOT_IMPERSONATING', message: 'No active impersonation' } });
  }

  const stash = await loadStash(stashId);
  if (!stash) {
    clearAuthCookies(res);
    clearImpersonationCookies(res);
    return res.status(401).json({ success: false, error: { code: 'STASH_EXPIRED', message: 'Impersonation expired — please log in again' } });
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
