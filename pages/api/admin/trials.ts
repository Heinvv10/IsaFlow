/**
 * Admin Trials API
 * GET  /api/admin/trials          — trials still running that end within `within` days (default 30),
 *                                   or every trial company incl. expired and converted with `scope=all`
 * POST /api/admin/trials          — extend trial for one or many companies (single: 404 unknown/deleted,
 *                                   409 already paying; bulk skips those and counts what moved)
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { trustedClientIp } from '@/lib/trustedClientIp';
import { logAdminAction } from '@/modules/admin/services/auditService';
import {
  getAllTrials,
  getExpiringTrials,
  extendTrial,
  bulkExtendTrials,
} from '@/modules/admin/services/trialService';
import { TrialExtendError } from '@/modules/admin/services/trialErrors';
import { UUID } from '@/lib/schemas/common';

const PostBody = z.union([
  z.object({
    company_id:  UUID,
    company_ids: z.undefined().optional(),
    days:        z.number().int().min(1).max(90),
  }).strict(),
  z.object({
    company_id:  z.undefined().optional(),
    company_ids: z.array(UUID).min(1).max(100),
    days:        z.number().int().min(1).max(90),
  }).strict(),
]);

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  /* ------------------------------------------------------------------ GET */
  if (req.method === 'GET') {
    try {
      if (req.query.scope === 'all') return apiResponse.success(res, await getAllTrials());
      const within = req.query.within ? Number(req.query.within) : 30;
      if (isNaN(within) || within < 1 || within > 365) {
        return apiResponse.badRequest(res, 'within must be 1–365');
      }
      const trials = await getExpiringTrials(within);
      return apiResponse.success(res, trials);
    } catch (err) {
      log.error('Failed to fetch trials', { error: err }, 'admin-trials-api');
      return apiResponse.badRequest(res, 'Failed to fetch trials');
    }
  }

  /* ----------------------------------------------------------------- POST */
  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const { company_id, company_ids, days } = parsed.data;

      const ip = trustedClientIp(req);
      const adminId = req.user.id;

      /* Single company extend */
      if (company_id) {
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
      // Raised before anything is written: nothing to roll back.
      if (err instanceof TrialExtendError) {
        return err.code === 'company_not_found'
          ? apiResponse.notFound(res, 'Company')
          : apiResponse.conflict(res, err.message);
      }
      log.error('Failed to extend trial', { error: err }, 'admin-trials-api');
      return apiResponse.badRequestFromError(res, err, 'Failed to extend trial');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAdmin(withCsrf(handler));
