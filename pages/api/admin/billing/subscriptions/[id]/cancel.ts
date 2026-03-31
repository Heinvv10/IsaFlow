/**
 * Admin Billing Subscription Cancel API
 * POST /api/admin/billing/subscriptions/[id]/cancel — Cancel a subscription
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { cancelSubscription } from '@/modules/admin/services/billingService';
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

  if (req.method === 'POST') {
    try {
      const { at_period_end } = req.body as { at_period_end?: boolean };

      const atPeriodEnd = at_period_end === true;
      await cancelSubscription(id, atPeriodEnd);

      await logAdminAction(
        req.user.id,
        'subscription.cancel',
        'subscription',
        id,
        { at_period_end: atPeriodEnd },
        getIp(req)
      );

      return apiResponse.success(res, { cancelled: true, at_period_end: atPeriodEnd });
    } catch (err) {
      log.error('Failed to cancel subscription', { id, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to cancel subscription');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(handler);
