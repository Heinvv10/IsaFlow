/**
 * GET /api/billing/upgrade/status
 *
 * What the self-serve upgrade page needs: whether the company is on a trial,
 * whether a chargeable Paystack mandate is already on file (then the owner only
 * confirms), and the plans a trial can convert to (read from the plans table,
 * the internal trial and payg plans left out).
 *
 * 404 unless the company has the dark flag `trial_self_serve_upgrade`; 403 for
 * any role but owner. The company is the verified request's.
 */

import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { listPlans } from '@/modules/admin/services/planService';
import { isConvertiblePlanCode } from '@/modules/admin/types/trialPlans';
import { getUpgradeState } from '@/modules/billing/services/selfServeUpgrade';
import { selfServeUpgradeEnabled, UPGRADE_ROLES } from '@/modules/billing/services/selfServeUpgradeGate';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  if (!(await selfServeUpgradeEnabled(req.companyId))) return apiResponse.notFound(res, 'Page');
  if (!UPGRADE_ROLES.includes(req.companyRole)) {
    return apiResponse.forbidden(res, 'Only the company owner can upgrade the subscription.');
  }

  const state = await getUpgradeState(req.companyId);
  const plans = (await listPlans(false))
    .filter((p) => isConvertiblePlanCode(p.code))
    .map((p) => ({
      id: p.id, code: p.code, name: p.name, description: p.description,
      monthly_price_cents: p.monthly_price_cents, currency: p.currency,
    }));
  return apiResponse.success(res, { ...state, plans });
}

export default withAuth(withErrorHandler(handler));
