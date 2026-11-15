/**
 * Admin Billing Subscriptions API
 * GET  /api/admin/billing/subscriptions — List subscriptions with filters
 * POST /api/admin/billing/subscriptions — Create a subscription
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { adminOptionalUuid, adminPaging, isPgError } from '@/modules/admin/middleware/adminRequestErrors';
import { apiResponse } from '@/lib/apiResponse';
import { listSubscriptions, createSubscription } from '@/modules/admin/services/billingService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { UUID } from '@/lib/schemas/common';

const PostBody = z.object({
  company_id:       UUID,
  plan_id:          UUID,
  billing_cycle:    z.enum(['monthly', 'annual']),
  discount_percent: z.number().min(0).max(50).optional(),
  notes:            z.string().max(2000).optional(),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const { company_id, status, plan_id, search, page, limit } = req.query;

    const result = await listSubscriptions({
      company_id: adminOptionalUuid(company_id, 'company_id'),
      status: status as string | undefined,
      plan_id: adminOptionalUuid(plan_id, 'plan_id'),
      search: search as string | undefined,
      ...adminPaging({ page, limit }),
    });

    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    const { company_id, plan_id, billing_cycle, discount_percent, notes } = parsed.data;

    let subscriptionId: string;
    try {
      subscriptionId = await createSubscription({
        company_id,
        plan_id,
        billing_cycle,
        discount_percent,
        notes,
      });
    } catch (err) {
      // The INSERT is the first write: the refusal aborted the transaction, so nothing lands.
      if (isPgError(err, '23503', ['subscriptions_company_id_fkey', 'subscriptions_plan_id_fkey'])) return apiResponse.badRequest(res, 'No such company or plan');
      throw err;
    }

    await logAdminAction(
      req.user.id,
      'subscription.create',
      'subscription',
      subscriptionId,
      { company_id: parsed.data.company_id, plan_id: parsed.data.plan_id, billing_cycle: parsed.data.billing_cycle },
      getIp(req)
    );

    return apiResponse.success(res, { id: subscriptionId });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withAdmin(withCsrf(handler));
