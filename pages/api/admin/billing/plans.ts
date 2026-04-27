/**
 * Admin Billing Plans API
 * GET  /api/admin/billing/plans — List all plans
 * POST /api/admin/billing/plans — Create a new plan
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { listPlans, createPlan } from '@/modules/admin/services/planService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

const PostBody = z.object({
  code:                 z.string().min(1).max(50),
  name:                 z.string().min(1).max(100),
  description:          z.string().max(500).optional(),
  monthly_price_cents:  z.number().int().nonnegative(),
  annual_price_cents:   z.number().int().nonnegative().optional(),
  currency:             z.string().length(3).optional(),
  features:             z.record(z.string(), z.unknown()).optional(),
  limits:               z.record(z.string(), z.unknown()).optional(),
  display_order:        z.number().int().min(0).optional(),
}).strict();

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
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const { code, name, description, monthly_price_cents, annual_price_cents, currency, features, limits, display_order } = parsed.data;

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
        { code: parsed.data.code, name: parsed.data.name, monthly_price_cents: parsed.data.monthly_price_cents },
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

export default withAdmin(withCsrf(handler));
