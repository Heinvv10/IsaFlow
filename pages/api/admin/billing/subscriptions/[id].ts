/**
 * Admin Billing Subscription Detail API
 * GET   /api/admin/billing/subscriptions/[id] — Get a single subscription
 * PATCH /api/admin/billing/subscriptions/[id] — Update a subscription
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { adminUuid, AdminUuid } from '@/modules/admin/middleware/adminRequestErrors';
import { apiResponse } from '@/lib/apiResponse';
import {
  cancelSubscription,
  getSubscription,
  updateSubscription,
} from '@/modules/admin/services/billingService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

const PatchBody = z.object({
  plan_id:          AdminUuid.optional(),
  billing_cycle:    z.enum(['monthly', 'annual']).optional(),
  discount_percent: z.number().min(0).max(50).optional(),
  status:           z.enum(['active', 'trial', 'past_due', 'cancelled']).optional(),
  notes:            z.string().max(2000).optional(),
  // The company billing tab PATCHes this to schedule a cancellation; without
  // it the strict schema rejected the only UI that offers the option. Only
  // `true` is accepted — clearing a scheduled cancellation is a reactivation,
  // which goes through `status`.
  cancel_at_period_end: z.literal(true).optional(),
}).strict()
  // An empty PATCH changes nothing and must not be audited as an update (review #1405 final round): a 400. Any other
  // body runs updateSubscription or cancelSubscription, both of which answer 404 for a missing subscription before
  // the audit row below.
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update: give at least one field');

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const id = adminUuid(req.query.id);

  if (req.method === 'GET') {
    const subscription = await getSubscription(id);
    if (!subscription) return apiResponse.notFound(res, 'Subscription not found');
    return apiResponse.success(res, subscription);
  }

  if (req.method === 'PATCH') {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    const { cancel_at_period_end, ...fields } = parsed.data;
    const body = parsed.data;
    let companyId: string | undefined;
    if (Object.keys(fields).length > 0) ({ companyId } = await updateSubscription(id, fields));
    if (cancel_at_period_end) ({ companyId } = await cancelSubscription(id, true));

    await logAdminAction(
      req.user.id,
      'subscription.update',
      'subscription',
      id,
      { ...body, company_id: companyId } as Record<string, unknown>,
      getIp(req),
    );

    return apiResponse.success(res, { updated: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PATCH']);
}

export default withAdmin(withCsrf(handler));
