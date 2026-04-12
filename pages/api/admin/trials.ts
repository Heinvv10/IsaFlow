/**
 * Admin Trials API
 * GET  /api/admin/trials          — expiring trials (within 30 days)
 * POST /api/admin/trials          — extend trial for one or many companies
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { logAdminAction } from '@/modules/admin/services/auditService';
import {
  getExpiringTrials,
  extendTrial,
  bulkExtendTrials,
} from '@/modules/admin/services/trialService';

interface ExtendBody {
  company_id?: string;
  company_ids?: string[];
  days: number;
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  /* ------------------------------------------------------------------ GET */
  if (req.method === 'GET') {
    try {
      const within = req.query.within ? Number(req.query.within) : 30;
      if (isNaN(within) || within < 1 || within > 365) {
        return apiResponse.badRequest(res, 'within must be 1–365');
      }
      const trials = await getExpiringTrials(within);
      return apiResponse.success(res, trials);
    } catch (err) {
      log.error('Failed to fetch expiring trials', { error: err }, 'admin-trials-api');
      return apiResponse.badRequest(res, 'Failed to fetch expiring trials');
    }
  }

  /* ----------------------------------------------------------------- POST */
  if (req.method === 'POST') {
    try {
      const body = req.body as ExtendBody;
      const { company_id, company_ids, days } = body;

      if (typeof days !== 'number' || days < 1 || days > 90) {
        return apiResponse.badRequest(res, 'days must be 1–90');
      }

      const ip = (req.headers['x-forwarded-for'] as string | undefined) ?? null;
      const adminId = req.user.id;

      /* Single company extend */
      if (company_id) {
        if (typeof company_id !== 'string' || !company_id.trim()) {
          return apiResponse.badRequest(res, 'company_id must be a non-empty string');
        }
        const newEndsAt = await extendTrial(company_id, days);
        await logAdminAction(
          adminId,
          'trial.extend',
          'company',
          company_id,
          { days, new_trial_ends_at: newEndsAt },
          ip
        );
        log.info('Trial extended', { company_id, days, newEndsAt }, 'admin-trials-api');
        return apiResponse.success(res, { company_id, days, trial_ends_at: newEndsAt });
      }

      /* Bulk extend */
      if (Array.isArray(company_ids) && company_ids.length > 0) {
        if (company_ids.length > 100) {
          return apiResponse.badRequest(res, 'Maximum 100 companies per bulk operation');
        }
        const count = await bulkExtendTrials(company_ids, days);
        await logAdminAction(
          adminId,
          'trial.bulk_extend',
          'company',
          null,
          { company_ids, days, affected: count },
          ip
        );
        log.info('Bulk trial extension', { count, days }, 'admin-trials-api');
        return apiResponse.success(res, { extended: count, days });
      }

      return apiResponse.badRequest(res, 'Provide company_id or company_ids[]');
    } catch (err) {
      log.error('Failed to extend trial', { error: err }, 'admin-trials-api');
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Failed to extend trial');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAdmin(handler);
