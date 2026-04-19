// pages/api/admin/users/[id]/reset-2fa.ts
// Super-admin operation: wipe all of the target user's MFA factors so they
// can log in without 2FA and re-enroll. Used when a user loses their device.
import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import type { PlatformAdminRequest } from '@/lib/auth';
import { adminUnenrollFactor, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

interface AuthFactorRow {
  id: string;
  user_id: string;
}

async function handler(req: PlatformAdminRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
    return;
  }
  const targetUserId = req.query.id;
  if (typeof targetUserId !== 'string') {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'User id required' } });
    return;
  }

  // platform_admin can SELECT from auth.mfa_factors thanks to the grant in
  // migration 354 (to be applied). This query runs inside the handler's
  // platform_admin tx, so BYPASSRLS is engaged.
  const factors = await sql<AuthFactorRow>`
    SELECT id::text, user_id::text
    FROM auth.mfa_factors
    WHERE user_id = ${targetUserId}::uuid
  `;

  let removed = 0;
  for (const f of factors) {
    try {
      await adminUnenrollFactor(f.user_id, f.id);
      removed++;
    } catch (err) {
      if (err instanceof GotrueMfaError && err.status === 404) continue; // already gone
      log.warn(
        'admin reset-2fa: factor unenroll failed',
        { factor_id: f.id, status: err instanceof GotrueMfaError ? err.status : 'unknown' },
        'Auth'
      );
    }
  }

  res.status(200).json({ success: true, data: { factors_removed: removed } });
}

export default withAdmin(handler);
