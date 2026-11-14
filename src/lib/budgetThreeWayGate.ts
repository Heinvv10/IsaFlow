/**
 * The gate every three-way route passes first (budgets P6, spec §7, §13.13):
 * the dark feature flag, called directly (`hasFeature`, the MCP route's
 * precedent), then a per-user rate limit (the runs read the ledger, the VAT201
 * and the EMP201).
 * Answers 403 or 429 itself and returns false; true lets the handler go on.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { checkRateLimit } from '@/lib/rateLimit';
import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { THREE_WAY_FEATURE } from '@/modules/accounting/services/budgets/threeWay/routeSchemas';

export async function passThreeWayGate(
  res: NextApiResponse, companyId: string, userId: string, bucket: 'read' | 'save',
): Promise<boolean> {
  if (!(await hasFeature(companyId, THREE_WAY_FEATURE))) {
    apiResponse.forbidden(res, 'The balance sheet and cash budget is not enabled for this company');
    return false;
  }
  // Per user per minute: 60 reads (each a full run), 120 saves (the grid save's limit). Literal keys and options: the R-175 census reads them.
  const allowed = bucket === 'save'
    ? await checkRateLimit(`budget-three-way-save:${userId}`, { max: 120, windowSecs: 60 })
    : await checkRateLimit(`budget-three-way:${userId}`, { max: 60, windowSecs: 60 });
  if (!allowed) {
    res.setHeader('Retry-After', '60');
    apiResponse.tooManyRequests(res, 'Too many budget requests; wait a minute and try again.');
    return false;
  }
  return true;
}
