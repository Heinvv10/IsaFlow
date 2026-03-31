/**
 * Admin Billing Plans API
 * GET  /api/admin/billing/plans — List all plans
 * POST /api/admin/billing/plans — Create a new plan
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { listPlans, createPlan } from '@/modules/admin/services/planService';
import { logAdminAction } from '@/modules/admin/services/auditService';

function getIp(req: AuthenticatedNextApiRequest): string | null {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const includeArchived = req.query.include_archived === 'true';
      const plans = await listPlans(includeArchived);
      return apiResponse.success(res, plans);
    } catch (err) {
      log.error('Failed to list plans', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to list plans');
    }
  }

  if (req.method === 'POST') {
    try {
      const {
        code,
        name,
        description,
        monthly_price_cents,
        annual_price_cents,
        currency,
        features,
        limits,
        display_order,
      } = req.body as {
        code: string;
        name: string;
        description?: string;
        monthly_price_cents: number;
        annual_price_cents: number | undefined;
        currency?: string;
        features?: Record<string, unknown>;
        limits?: Record<string, unknown>;
        display_order?: number;
      };

      if (!code || !name || monthly_price_cents == null) {
        return apiResponse.badRequest(res, 'code, name, and monthly_price_cents are required');
      }

      const plan = await createPlan({
        code,
        name,
        description,
        monthly_price_cents,
        annual_price_cents: annual_price_cents ?? monthly_price_cents,
        currency,
        features,
        limits,
        display_order,
      });

      await logAdminAction(
        req.user.id,
        'plan.create',
        'plan',
        plan.id,
        { code, name, monthly_price_cents },
        getIp(req)
      );

      return apiResponse.success(res, plan);
    } catch (err) {
      log.error('Failed to create plan', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to create plan');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withAdmin(handler);
