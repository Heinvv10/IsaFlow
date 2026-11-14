// pages/api/admin/users/[id]/reset-2fa.ts
// Super-admin operation: wipe all of the target user's MFA factors so they
// can log in without 2FA and re-enroll. Used when a user loses their device.
// Uses GoTrue's admin HTTP API exclusively — auth.mfa_factors lives in the
// shared postgres database, not per-app DBs, so direct SQL would fail.
//
// Audited so that no later failure can erase the record (admin audit
// 2026-11-14, 3.3):
//   1. `user.reset_2fa_started` (the factor ids about to be removed) COMMITS
//      on its own connection (withOwnPlatformAdminTx) before GoTrue is touched.
//      If it cannot be written, nothing is removed (500).
//   2. Each factor is then removed. A 404 means already gone. Any other 4xx is
//      a definite refusal (not removed). A timeout, outage or 5xx is AMBIGUOUS:
//      GoTrue may have deleted the factor before the answer was lost, so it is
//      recorded as `unknown`, never as "not removed", and the loop stops there
//      (the rest are `not_attempted`).
//   3. `user.reset_2fa` records the outcome in the request transaction: 200
//      when every factor went, else 424 (DEPENDENCY_ERROR, commits) saying
//      what is known. If this row fails, the 500 rolls it back but step 1's
//      row stands, so a retry or a failure cannot leave the removal unrecorded.
import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import type { PlatformAdminRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { adminListUserFactors, adminUnenrollFactor, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { AuthUpstreamUnavailableError, respondIfAuthUnavailable } from '@/lib/auth/authUpstream';
import { withOwnPlatformAdminTx } from '@/lib/auth/platformAdminOwnTx';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

type Outcome = { removed: string[]; gone: string[]; refused: string[]; unknown: string[]; notAttempted: string[] };

/** Removes each factor and sorts it by what is KNOWN to have happened at GoTrue. Never throws. */
async function removeFactors(userId: string, factorIds: string[]): Promise<Outcome> {
  const out: Outcome = { removed: [], gone: [], refused: [], unknown: [], notAttempted: [] };
  for (const [i, id] of factorIds.entries()) {
    try {
      await adminUnenrollFactor(userId, id);
      out.removed.push(id);
    } catch (err) {
      const status = err instanceof GotrueMfaError ? err.status : null;
      log.warn('admin reset-2fa: factor unenroll failed', { factor_id: id, status: status ?? 'unknown' }, 'Auth');
      if (status === 404) { out.gone.push(id); continue; }
      if (status !== null && status < 500) { out.refused.push(id); continue; }
      out.unknown.push(id); // timed out, outage or 5xx: GoTrue may have removed it
      if (err instanceof AuthUpstreamUnavailableError) { out.notAttempted.push(...factorIds.slice(i + 1)); break; }
    }
  }
  return out;
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
  const factorIds = factors.map((f) => f.id);
  const started = {
    factors_found: factorIds.length,
    factor_ids: factorIds,
    ...(target?.role === 'super_admin' ? { target_super_admin: true } : {}),
  };
  await withOwnPlatformAdminTx(() => logAdminAction(req.user.id, 'user.reset_2fa_started', 'user', targetUserId, started, ip));

  const out = await removeFactors(targetUserId, factorIds);
  const complete = out.refused.length + out.unknown.length + out.notAttempted.length === 0;
  await logAdminAction(req.user.id, 'user.reset_2fa', 'user', targetUserId, {
    ...started,
    outcome: complete ? 'complete' : out.unknown.length > 0 ? 'unknown' : 'incomplete',
    factors_removed: out.removed.length,
    removed_factor_ids: out.removed,
    already_gone_factor_ids: out.gone,
    failed_factor_ids: out.refused,
    unknown_factor_ids: out.unknown,
    not_attempted_factor_ids: out.notAttempted,
  }, ip);

  if (!complete) {
    const parts = [`${out.removed.length} of ${factorIds.length} factors removed`];
    if (out.refused.length > 0) parts.push(`${out.refused.length} refused by the auth service`);
    if (out.unknown.length > 0) parts.push(`${out.unknown.length} may or may not have been removed (no answer)`);
    if (out.notAttempted.length > 0) parts.push(`${out.notAttempted.length} not attempted`);
    apiResponse.error(res, ErrorCode.DEPENDENCY_ERROR,
      `2FA was NOT confirmed reset: ${parts.join(', ')}. The user may still be asked for a code. Try again.`);
    return;
  }

  res.status(200).json({ success: true, data: { factors_removed: out.removed.length } });
}

export default withAdmin(withCsrf(handler));
