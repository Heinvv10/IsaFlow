/**
 * Admin Billing Subscription Detail API
 * GET   /api/admin/billing/subscriptions/[id] — Get a single subscription
 * PATCH /api/admin/billing/subscriptions/[id] — Update a subscription
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { getSubscription, updateSubscription } from '@/modules/admin/services/billingService';
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
      const body = req.body as {
        plan_id?: string;
        billing_cycle?: string;
        discount_percent?: number;
        status?: string;
        notes?: string;
      };
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);
