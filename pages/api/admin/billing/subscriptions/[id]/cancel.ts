/**
 * Admin Billing Subscription Cancel API
 * POST /api/admin/billing/subscriptions/[id]/cancel — Cancel a subscription
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { cancelSubscription } from '@/modules/admin/services/billingService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

const PostBody = z.object({
  at_period_end: z.boolean().optional(),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const id = req.query.id as string;

  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const atPeriodEnd = parsed.data.at_period_end === true;
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
