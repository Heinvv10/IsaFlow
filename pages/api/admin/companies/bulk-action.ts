/**
 * Admin Bulk Company Action API
 * POST /api/admin/companies/bulk-action
 * Supports: suspend, extend_trial
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { suspendCompany } from '@/modules/admin/services/adminCompanyService';
import { extendTrialIfExists } from '@/modules/admin/services/trialService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { adminDistinctUuids } from '@/modules/admin/middleware/adminRequestErrors';

const MAX_BULK_IDS = 100;

const PostBody = z.discriminatedUnion('action', [
  z.object({
    action:      z.literal('suspend'),
    company_ids: adminDistinctUuids(MAX_BULK_IDS),
    // Required and trimmed: the admin types why (audit 3.7); no placeholder reason.
    reason:      z.string().trim().min(1).max(500),
  }).strict(),
  z.object({
    action:      z.literal('extend_trial'),
    company_ids: adminDistinctUuids(MAX_BULK_IDS),
    days:        z.number().int().min(1).max(90),
  }).strict(),
]);

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const bodyParsed = PostBody.safeParse(req.body);
  if (!bodyParsed.success) {
    return apiResponse.badRequest(res, bodyParsed.error.issues[0]?.message ?? 'Invalid input');
  }

  const body = bodyParsed.data;
  const { action, company_ids } = body;

  const ip = getIp(req);
  const errors: string[] = [];
  let processed = 0;

  if (action === 'suspend') {
    const { reason } = body;

    // The per-item refusals (missing, deleted) are answers, not throws. Anything thrown (a failed critical audit,
    // a database error) aborts the whole batch: a 500 that rolls every item back, never a 200 reporting items that
    // the poisoned transaction would not keep (review #1405 L8).
    for (const companyId of company_ids) {
      // A deleted company is skipped, never suspended (that would undelete it).
      if (!(await suspendCompany(companyId, reason))) {
        errors.push(`${companyId}: not found or deleted`);
        continue;
      }
      await logAdminAction(req.user.id, 'company.suspend', 'company', companyId, { reason, bulk: true }, ip);
      processed++;
    }

    return apiResponse.success(res, { processed, errors });
  }

  if (action === 'extend_trial') {
    const { days } = body;

    // Same as suspend: refusals are answers; anything thrown aborts the whole batch (500, rolled back).
    for (const companyId of company_ids) {
      // Same rule as the Trials page: from the later of the current end and
      // today, never on a deleted, missing or already-paying company (not "processed").
      const result = await extendTrialIfExists(companyId, days);
      if (result.kind !== 'extended') {
        errors.push(`${companyId}: ${result.kind === 'already_paid' ? 'already on a paid plan' : 'not found or deleted'}`);
        continue;
      }
      await logAdminAction(
        req.user.id,
        'company.extend_trial',
        'company',
        companyId,
        { days, bulk: true },
        ip
      );
      processed++;
    }

    return apiResponse.success(res, { processed, errors });
  }

  return apiResponse.badRequest(res, `Unknown action: ${String(action)}`);
}

export default withAdmin(withCsrf(handler));
