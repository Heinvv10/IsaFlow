/**
 * Admin Bulk Company Action API
 * POST /api/admin/companies/bulk-action
 * Supports: suspend, extend_trial
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { suspendCompany } from '@/modules/admin/services/adminCompanyService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { sql } from '@/lib/neon';
import { UUID } from '@/lib/schemas/common';

const MAX_BULK_IDS = 100;

const PostBody = z.discriminatedUnion('action', [
  z.object({
    action:      z.literal('suspend'),
    company_ids: z.array(UUID).min(1).max(MAX_BULK_IDS),
    reason:      z.string().max(500).optional(),
  }).strict(),
  z.object({
    action:      z.literal('extend_trial'),
    company_ids: z.array(UUID).min(1).max(MAX_BULK_IDS),
    days:        z.number().int().min(1).max(90),
  }).strict(),
]);

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const bodyParsed = PostBody.safeParse(req.body);
  if (!bodyParsed.success) {
    return apiResponse.badRequest(res, bodyParsed.error.flatten().formErrors[0] ?? 'Invalid input');
  }

  const body = bodyParsed.data;
  const { action, company_ids } = body;

  const ip = getIp(req);
  const errors: string[] = [];
  let processed = 0;

  if (action === 'suspend') {
    const reason = body.reason?.trim() || 'Bulk suspended by admin';

    for (const companyId of company_ids) {
      try {
        await suspendCompany(companyId, reason);
        await logAdminAction(req.user.id, 'company.suspend', 'company', companyId, { reason, bulk: true }, ip);
        processed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`${companyId}: ${msg}`);
        log.error('bulk suspend failed for company', { companyId, error: err }, 'admin-bulk-action');
      }
    }

    return apiResponse.success(res, { processed, errors });
  }

  if (action === 'extend_trial') {
    const { days } = body;

    for (const companyId of company_ids) {
      try {
        // Extend existing trial_ends_at or base from NOW() if null
        await sql`
          UPDATE companies
          SET trial_ends_at = COALESCE(trial_ends_at, NOW()) + (${days} || ' days')::INTERVAL,
              updated_at    = NOW()
          WHERE id = ${companyId}
        `;
        await logAdminAction(
          req.user.id,
          'company.extend_trial',
          'company',
          companyId,
          { days, bulk: true },
          ip
        );
        processed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`${companyId}: ${msg}`);
        log.error('bulk extend_trial failed for company', { companyId, error: err }, 'admin-bulk-action');
      }
    }

    return apiResponse.success(res, { processed, errors });
  }

  return apiResponse.badRequest(res, `Unknown action: ${String(action)}`);
}

export default withAdmin(handler);
