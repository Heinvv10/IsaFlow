/**
 * Admin Billing Subscription Detail API
 * GET   /api/admin/billing/subscriptions/[id] — Get a single subscription
 * PATCH /api/admin/billing/subscriptions/[id] — Update a subscription
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { getSubscription, updateSubscription } from '@/modules/admin/services/billingService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';


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
    try {
      const { plan_id, billing_cycle, discount_percent, status, notes } = req.body as {
        plan_id?: string;
        billing_cycle?: string;
        discount_percent?: number;
        status?: string;
        notes?: string;
      };

      const VALID_STATUSES = ['active', 'trial', 'past_due', 'cancelled', 'suspended'];
      if (status && !VALID_STATUSES.includes(status)) {
        return apiResponse.badRequest(res, `Invalid status. Allowed: ${VALID_STATUSES.join(', ')}`);
      }
      if (discount_percent != null && (discount_percent < 0 || discount_percent > 50)) {
        return apiResponse.badRequest(res, 'discount_percent must be between 0 and 50');
      }
      const VALID_CYCLES = ['monthly', 'annual'];
      if (billing_cycle && !VALID_CYCLES.includes(billing_cycle)) {
        return apiResponse.badRequest(res, `Invalid billing_cycle. Allowed: ${VALID_CYCLES.join(', ')}`);
      }

      const body = { plan_id, billing_cycle, discount_percent, status, notes };
      await updateSubscription(id, body);

      await logAdminAction(
        req.user.id,
        'subscription.update',
        'subscription',
        id,
        body as Record<string, unknown>,
        getIp(req)
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
