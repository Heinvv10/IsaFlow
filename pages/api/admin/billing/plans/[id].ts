/**
 * Admin Billing Plan Detail API
 * GET    /api/admin/billing/plans/[id] — Get a single plan
 * PATCH  /api/admin/billing/plans/[id] — Update a plan
 * DELETE /api/admin/billing/plans/[id] — Archive a plan
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { getPlan, updatePlan, archivePlan } from '@/modules/admin/services/planService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

const PatchBody = z.object({
  name:                 z.string().min(1).max(100).optional(),
  description:          z.string().max(500).optional(),
  monthly_price_cents:  z.number().int().nonnegative().optional(),
  annual_price_cents:   z.number().int().nonnegative().optional(),
  currency:             z.string().length(3).optional(),
  features:             z.record(z.string(), z.unknown()).optional(),
  limits:               z.record(z.string(), z.unknown()).optional(),
  is_active:            z.boolean().optional(),
  display_order:        z.number().int().min(0).optional(),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const id = req.query.id as string;

  if (req.method === 'GET') {
    try {
      const plan = await getPlan(id);
      if (!plan) return apiResponse.notFound(res, 'Plan not found');
      return apiResponse.success(res, plan);
    } catch (err) {
      log.error('Failed to get plan', { id, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to get plan');
    }
  }

  if (req.method === 'PATCH') {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const body = parsed.data;
      await updatePlan(id, body);

      await logAdminAction(
        req.user.id,
        'plan.update',
        'plan',
        id,
        body,
        getIp(req)
      );

      return apiResponse.success(res, { updated: true });
    } catch (err) {
      log.error('Failed to update plan', { id, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to update plan');
    }
  }

  if (req.method === 'DELETE') {
    try {
      await archivePlan(id);

      await logAdminAction(
        req.user.id,
        'plan.archive',
        'plan',
        id,
        null,
        getIp(req)
      );

      return apiResponse.success(res, { archived: true });
    } catch (err) {
      log.error('Failed to archive plan', { id, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to archive plan');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PATCH', 'DELETE']);
}

export default withAdmin(withCsrf(handler));
