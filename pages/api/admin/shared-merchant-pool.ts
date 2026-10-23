/**
 * Admin — recompute the shared merchant-pattern pool now (learning loop PR 2, decision 6).
 * POST /api/admin/shared-merchant-pool  { action: 'recompute' }  -> queued; the run starts after this commits
 *
 * The same job the nightly cron runs (sharedPoolJob.ts). It is queued with runAfterCommit, so it runs off
 * this request's platform_admin connection, on the pool role, exactly as from cron: the job reads every
 * eligible company's coding and writes only through shared_pool_publish, which platform_admin cannot
 * execute. The run's counts are in the log ('shared-pool'). Audited (admin_audit_log, shared_pool_recompute);
 * 409 while a run is in progress in this process, so repeated clicks cannot stack full scans.
 *
 * While the legal-review gate is off (MERCHANT_SHARING_ENABLED, merchantSharingGate.ts) it answers 409 with
 * code 'sharing_pending_legal_review', as PUT /api/bureau/settings does for switching sharing on, and queues
 * nothing and audits nothing. The job checks the gate again itself, so a run queued just before the flag
 * went off still does nothing.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { runAfterCommit } from '@/lib/afterCommit';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { isSharedPoolRunning, runSharedPoolAggregation } from '@/modules/accounting/services/sharedPool/sharedPoolJob';
import { isMerchantSharingEnabled, MERCHANT_SHARING_PENDING_CODE } from '@/modules/bureau/services/merchantSharingGate';

const PostBody = z.object({ action: z.literal('recompute') }).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const parsed = PostBody.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, "action must be 'recompute'");
  if (!isMerchantSharingEnabled()) {
    return apiResponse.conflict(res, 'The shared merchant pool is off: sharing is disabled pending legal review',
      { code: MERCHANT_SHARING_PENDING_CODE });
  }
  if (isSharedPoolRunning()) return apiResponse.conflict(res, 'A shared pool recompute is already running');
  await logAdminAction(req.user.id, 'shared_pool_recompute', 'shared_merchant_pool', null, null, getIp(req));
  runAfterCommit('shared-merchant-pool: admin recompute', runSharedPoolAggregation);
  log.info('Shared merchant pool recompute queued via admin API', { userId: req.user.id }, 'admin-shared-pool');
  return apiResponse.success(res, { queued: true }, 'Recompute queued; it starts once this request commits');
}

export default withAdmin(withCsrf(handler));
