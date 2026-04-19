// pages/api/admin/users/[id]/reset-2fa.ts
// Super-admin operation: wipe all of the target user's MFA factors so they
// can log in without 2FA and re-enroll. Used when a user loses their device.
// Uses GoTrue's admin HTTP API exclusively — auth.mfa_factors lives in the
// shared postgres database, not per-app DBs, so direct SQL would fail.
import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import type { PlatformAdminRequest } from '@/lib/auth';
import { adminListUserFactors, adminUnenrollFactor, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { log } from '@/lib/logger';

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

  let factors;
  try {
    factors = await adminListUserFactors(targetUserId);
  } catch (err) {
    if (err instanceof GotrueMfaError && err.status === 404) {
      res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found in GoTrue' } });
      return;
    }
    throw err;
  }

  let removed = 0;
  for (const f of factors) {
    try {
      await adminUnenrollFactor(targetUserId, f.id);
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
