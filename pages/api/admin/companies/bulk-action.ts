/**
 * Admin Bulk Company Action API
 * POST /api/admin/companies/bulk-action
 * Supports: suspend, extend_trial
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { suspendCompany } from '@/modules/admin/services/adminCompanyService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { sql } from '@/lib/neon';

type BulkActionPayload =
  | { action: 'suspend'; company_ids: string[]; reason?: string }
  | { action: 'extend_trial'; company_ids: string[]; days: number };

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const body = req.body as BulkActionPayload;
  const { action, company_ids } = body;

  if (!Array.isArray(company_ids) || company_ids.length === 0) {
    return apiResponse.badRequest(res, 'company_ids must be a non-empty array');
  }

  // Validate IDs are strings (basic UUID-ish guard)
  for (const id of company_ids) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      return apiResponse.badRequest(res, 'Invalid company_id in list');
    }
  }

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

    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 90) {
      return apiResponse.badRequest(res, 'days must be an integer between 1 and 90');
    }

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
