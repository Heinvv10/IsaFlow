/**
 * Admin — recompute the shared merchant-pattern pool now (learning loop PR 2, decision 6).
 * POST /api/admin/shared-merchant-pool  { action: 'recompute' }  -> queued; the run starts after this commits
 *
 * The same job the nightly cron runs (sharedPoolJob.ts). It is queued with runAfterCommit, so it runs off
 * this request's platform_admin connection, on the pool role, exactly as from cron: the job reads every
 * eligible company's coding and writes only through shared_pool_publish, which platform_admin cannot
 * execute. The run's counts are in the log ('shared-pool').
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { runAfterCommit } from '@/lib/afterCommit';
import { runSharedPoolAggregation } from '@/modules/accounting/services/sharedPool/sharedPoolJob';

const PostBody = z.object({ action: z.literal('recompute') }).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const parsed = PostBody.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, "action must be 'recompute'");
  runAfterCommit('shared-merchant-pool: admin recompute', runSharedPoolAggregation);
  log.info('Shared merchant pool recompute queued via admin API', { userId: req.user.id }, 'admin-shared-pool');
  return apiResponse.success(res, { queued: true }, 'Recompute queued; it starts once this request commits');
}

export default withAdmin(withCsrf(handler));
