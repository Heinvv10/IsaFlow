/**
 * GET /api/billing/flows/wallet — current balance, nudge, month usage
 * for the authenticated company.  Only tenants on the `payg` plan may call
 * this route; others receive 403.
 */

import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { getWallet } from '@/modules/billing/services/flowWalletService';
import { getCompanyPlan } from '@/lib/billing/getCompanyPlan';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const plan = await getCompanyPlan(req.companyId);
  if (!plan || plan.planCode !== 'payg') {
    return apiResponse.forbidden(res, 'Flows wallet is only available on the Pay-As-You-Go plan');
  }

  const wallet = await getWallet(req.companyId);
  // Treat missing wallet row as zero-balance + 'none' nudge.
  return apiResponse.success(res, wallet ?? {
    companyId: req.companyId,
    balance: 0,
    autoTopupEnabled: false,
    autoTopupBundleId: null,
    paymentMethodToken: null,
    nudgeLevel: 'none',
    monthFlowsUsed: 0,
    monthResetAt: new Date(),
  });
}

export default withAuth(withErrorHandler(handler));
