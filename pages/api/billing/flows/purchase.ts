/**
 * POST /api/billing/flows/purchase — buy a Flow bundle.
 *
 * v1 is admin-recorded only: we book the purchase + ledger rows immediately.
 * v2 will redirect to Stitch checkout and reconcile via the payment webhook.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import { purchaseBundle } from '@/modules/billing/services/flowWalletService';
import { getCompanyPlan } from '@/lib/billing/getCompanyPlan';

const PurchaseBody = z.object({
  bundleId: z.string().uuid(),
}).strict();

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const plan = await getCompanyPlan(req.companyId);
  if (!plan || plan.planCode !== 'payg') {
    return apiResponse.forbidden(res, 'Flows can only be purchased on the Pay-As-You-Go plan');
  }

  const parsed = PurchaseBody.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
  }

  const result = await purchaseBundle(req.companyId, parsed.data.bundleId, {
    paymentMethod: 'admin_recorded',
    autoTriggered: false,
  });
  return apiResponse.created(res, result, 'Flows purchased');
}

export default withAuth(withErrorHandler(withCsrf(handler)));
