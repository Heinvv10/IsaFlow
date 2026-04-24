/**
 * PATCH /api/billing/flows/auto-topup — enable/disable auto top-up and
 * set which bundle to buy when balance hits zero.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import { setAutoTopup } from '@/modules/billing/services/flowWalletService';
import { getCompanyPlan } from '@/lib/billing/getCompanyPlan';

const Body = z.object({
  enabled:  z.boolean(),
  bundleId: z.string().uuid().nullable().optional(),
}).strict().refine((v) => !v.enabled || !!v.bundleId, {
  message: 'bundleId is required when enabling auto-topup',
  path: ['bundleId'],
});

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'PATCH') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PATCH']);
  }

  const plan = await getCompanyPlan(req.companyId);
  if (!plan || plan.planCode !== 'payg') {
    return apiResponse.forbidden(res, 'Auto-topup is only available on the Pay-As-You-Go plan');
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
  }

  await setAutoTopup(req.companyId, parsed.data.enabled, parsed.data.bundleId ?? null);
  return apiResponse.success(res, { enabled: parsed.data.enabled, bundleId: parsed.data.bundleId ?? null });
}

export default withAuth(withErrorHandler(withCsrf(handler)));
