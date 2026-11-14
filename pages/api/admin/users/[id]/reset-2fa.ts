// pages/api/admin/users/[id]/reset-2fa.ts
// Super-admin operation: wipe all of the target user's MFA factors so they
// can log in without 2FA and re-enroll. Used when a user loses their device.
// Uses GoTrue's admin HTTP API exclusively — auth.mfa_factors lives in the
// shared postgres database, not per-app DBs, so direct SQL would fail.
//
// Audited before GoTrue is touched (admin audit 2026-11-14, 3.3): the
// `user.reset_2fa` row is written first, so a failed audit write (500, rolled
// back) removes no factor. A factor GoTrue would not remove is never reported
// as success: the answer is 424 naming how many went, and a
// `user.reset_2fa_incomplete` row records which did not (a 424 commits both
// rows). An outage before any factor went is the usual 503 (D9): nothing
// changed, the rollback drops the audit row and withPlatformAdmin records the
// attempt as admin_request_failed.
import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import type { PlatformAdminRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { adminListUserFactors, adminUnenrollFactor, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { AuthUpstreamUnavailableError, respondIfAuthUnavailable } from '@/lib/auth/authUpstream';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

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
    if (respondIfAuthUnavailable(res, err, 'admin reset-2fa')) return;
    if (err instanceof GotrueMfaError && err.status === 404) {
      res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found in GoTrue' } });
      return;
    }
    throw err;
  }

  const [target] = await sql<{ role: string | null }>`SELECT role FROM users WHERE id = ${targetUserId} LIMIT 1`;
  const ip = getIp(req);
  await logAdminAction(req.user.id, 'user.reset_2fa', 'user', targetUserId, {
    factors_found: factors.length,
    factor_ids: factors.map((f) => f.id),
    ...(target?.role === 'super_admin' ? { target_super_admin: true } : {}),
  }, ip);

  let removed = 0;
  const failed: string[] = [];
  for (const f of factors) {
    try {
      await adminUnenrollFactor(targetUserId, f.id);
      removed++;
    } catch (err) {
      if (err instanceof GotrueMfaError && err.status === 404) continue; // already gone
      // D9: nothing removed yet, so nothing changed: the outage answer (503) rolls the audit row back.
      if (removed === 0 && failed.length === 0 && respondIfAuthUnavailable(res, err, 'admin reset-2fa')) return;
      log.warn(
        'admin reset-2fa: factor unenroll failed',
        { factor_id: f.id, status: err instanceof GotrueMfaError ? err.status : 'unknown' },
        'Auth'
      );
      failed.push(f.id);
      if (err instanceof AuthUpstreamUnavailableError) {
        // GoTrue is down: the rest would fail the same way. Report them as not removed.
        failed.push(...factors.slice(factors.indexOf(f) + 1).map((rest) => rest.id));
        break;
      }
    }
  }

  if (failed.length > 0) {
    await logAdminAction(req.user.id, 'user.reset_2fa_incomplete', 'user', targetUserId,
      { factors_found: factors.length, factors_removed: removed, failed_factor_ids: failed }, ip);
    apiResponse.error(res, ErrorCode.DEPENDENCY_ERROR,
      `2FA was NOT fully reset: ${removed} of ${factors.length} factors removed, ${failed.length} could not be. ` +
      'The user may still be asked for a code. Try again.');
    return;
  }

  res.status(200).json({ success: true, data: { factors_removed: removed } });
}

export default withAdmin(withCsrf(handler));
