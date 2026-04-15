/**
 * Admin Billing Subscription Detail API
 * GET   /api/admin/billing/subscriptions/[id] — Get a single subscription
 * PATCH /api/admin/billing/subscriptions/[id] — Update a subscription
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { getSubscription, updateSubscription } from '@/modules/admin/services/billingService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { UUID } from '@/lib/schemas/common';

const PatchBody = z.object({
  plan_id:          UUID.optional(),
  billing_cycle:    z.enum(['monthly', 'annual']).optional(),
  discount_percent: z.number().min(0).max(50).optional(),
  status:           z.enum(['active', 'trial', 'past_due', 'cancelled', 'suspended']).optional(),
  notes:            z.string().max(2000).optional(),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const id = req.query.id as string;

  if (req.method === 'GET') {
    try {
      const subscription = await getSubscription(id);
      if (!subscription) return apiResponse.notFound(res, 'Subscription not found');
      return apiResponse.success(res, subscription);
    } catch (err) {
      log.error('Failed to get subscription', { id, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to get subscription');
    }
  }

  if (req.method === 'PATCH') {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const body = parsed.data;
      await updateSubscription(id, body);

      await logAdminAction(
        req.user.id,
        'subscription.update',
        'subscription',
        id,
        body as Record<string, unknown>,
        getIp(req),
      );

      return apiResponse.success(res, { updated: true });
    } catch (err) {
      log.error('Failed to update subscription', { id, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to update subscription');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PATCH']);
}

export default withAdmin(handler);
