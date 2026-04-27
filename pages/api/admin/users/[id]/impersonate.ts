/**
 * POST /api/admin/users/:id/impersonate
 * Super-admin "Login as X" — swaps admin's session for target's via GoTrue
 * magic-link. Admin's tokens are stashed so end-impersonation can restore.
 */
import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import type { PlatformAdminRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  parseCookies,
  setAuthCookies,
  setActiveCompanyCookie,
  ACCESS_COOKIE,
  REFRESH_COOKIE,
} from '@/lib/auth/cookies';
import { generateLink, verifyMagicLink, GotrueAdminLinkError } from '@/lib/auth/gotrue-admin-link';
import { stashAdminTokens, validateImpersonationTarget } from '@/modules/admin/services/userImpersonationService';
import { setImpersonationCookies } from '@/lib/auth/impersonation-cookies';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

async function handler(req: PlatformAdminRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
    return;
  }
  const targetId = req.query.id;
  if (typeof targetId !== 'string') {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'User id required' } });
    return;
  }

  let target;
  try {
    target = await validateImpersonationTarget(targetId);
  } catch (err) {
    const code = err instanceof Error ? err.message : 'TARGET_INVALID';
    const status = code === 'TARGET_NOT_FOUND' ? 404 : code === 'CANNOT_IMPERSONATE_SUPER_ADMIN' ? 403 : 400;
    res.status(status).json({ success: false, error: { code, message: code } });
    return;
  }

  const cookies = parseCookies(req);
  const adminAccess = cookies[ACCESS_COOKIE];
  const adminRefresh = cookies[REFRESH_COOKIE];
  if (!adminAccess || !adminRefresh) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin session cookies required' } });
    return;
  }

  let targetTokens;
  try {
    const link = await generateLink('magiclink', target.email);
    targetTokens = await verifyMagicLink(link.token, target.email);
  } catch (err) {
    log.error(
      'impersonate: gotrue flow failed',
      { message: err instanceof Error ? err.message : String(err), status: err instanceof GotrueAdminLinkError ? err.status : undefined },
      'Admin'
    );
    res.status(502).json({ success: false, error: { code: 'GOTRUE_FAILURE', message: 'Unable to start impersonation session' } });
    return;
  }

  const stashId = await stashAdminTokens({
    adminUserId: req.user.id,
    adminAccessToken: adminAccess,
    adminRefreshToken: adminRefresh,
    targetUserId: target.userId,
  });

  // Pentest H11: impersonation_start is a CRITICAL_ACTION — audit failure
  // rolls back the whole request (withAuth holds the tx open until the handler
  // returns). Audit-silent impersonation is not allowed.
  await sql`
    INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, details)
    VALUES (
      ${req.user.id},
      'impersonation_start',
      'user',
      ${target.userId},
      ${JSON.stringify({ stash_id: stashId, target_email: target.email })}::jsonb
    )
  `;

  setAuthCookies(res, {
    accessToken: targetTokens.access_token,
    refreshToken: targetTokens.refresh_token,
    expiresIn: targetTokens.expires_in,
  });

  const memberships = await sql<{ company_id: string }>`
    SELECT company_id FROM company_users
    WHERE user_id = ${target.userId}
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1
  `;
  if (memberships.length > 0) setActiveCompanyCookie(res, memberships[0]!.company_id);

  setImpersonationCookies(res, stashId);

  res.status(200).json({ success: true, data: { redirect: '/accounting' } });
}

export default withAdmin(withCsrf(handler));
