/**
 * Admin Billing Plan Detail API
 * GET    /api/admin/billing/plans/[id] — Get a single plan
 * PATCH  /api/admin/billing/plans/[id] — Update a plan
 * DELETE /api/admin/billing/plans/[id] — Archive a plan
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { getPlan, updatePlan, archivePlan } from '@/modules/admin/services/planService';
import { logAdminAction } from '@/modules/admin/services/auditService';

function getIp(req: AuthenticatedNextApiRequest): string | null {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

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
    try {
      const body = req.body as Record<string, unknown>;
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

export default withAdmin(handler);
