/**
 * Admin Billing Subscriptions API
 * GET  /api/admin/billing/subscriptions — List subscriptions with filters
 * POST /api/admin/billing/subscriptions — Create a subscription
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { listSubscriptions, createSubscription } from '@/modules/admin/services/billingService';
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
      const { status, plan_id, search, page, limit } = req.query;

      const result = await listSubscriptions({
        status: status as string | undefined,
        plan_id: plan_id as string | undefined,
        search: search as string | undefined,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      });

      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to list subscriptions', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to list subscriptions');
    }
  }

  if (req.method === 'POST') {
    try {
      const { company_id, plan_id, billing_cycle, discount_percent, notes } = req.body as {
        company_id: string;
        plan_id: string;
        billing_cycle: string;
        discount_percent?: number;
        notes?: string;
      };

      if (!company_id || !plan_id || !billing_cycle) {
        return apiResponse.badRequest(res, 'company_id, plan_id, and billing_cycle are required');
      }

      const subscriptionId = await createSubscription({
        company_id,
        plan_id,
        billing_cycle,
        discount_percent,
        notes,
      });

      await logAdminAction(
        req.user.id,
        'subscription.create',
        'subscription',
        subscriptionId,
        { company_id, plan_id, billing_cycle },
        getIp(req)
      );

      return apiResponse.success(res, { id: subscriptionId });
    } catch (err) {
      log.error('Failed to create subscription', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to create subscription');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);
