/**
 * The gate every three-way route passes first (budgets P6, spec §7, §13.13):
 * the dark feature flag, called directly (`hasFeature`, the MCP route's
 * precedent; `withFeature` answers a non-envelope "upgrade" 403), then a
 * per-user rate limit (the runs read the ledger, the VAT201 and the EMP201).
 * Answers 403 or 429 itself and returns false; true lets the handler go on.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { checkRateLimit } from '@/lib/rateLimit';
import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { THREE_WAY_FEATURE } from '@/modules/accounting/services/budgets/threeWay/routeSchemas';

/** Per user per minute: reads (a run each) and assumption saves. */
export const THREE_WAY_LIMITS = { read: 60, save: 120 } as const;

export async function passThreeWayGate(
  res: NextApiResponse, companyId: string, userId: string, bucket: keyof typeof THREE_WAY_LIMITS,
): Promise<boolean> {
  if (!(await hasFeature(companyId, THREE_WAY_FEATURE))) {
    apiResponse.forbidden(res, 'The balance sheet and cash budget is not enabled for this company');
    return false;
  }
  const key = bucket === 'save' ? `budget-three-way-save:${userId}` : `budget-three-way:${userId}`;
  if (!(await checkRateLimit(key, { max: THREE_WAY_LIMITS[bucket], windowSecs: 60 }))) {
    res.setHeader('Retry-After', '60');
    apiResponse.tooManyRequests(res, 'Too many budget requests; wait a minute and try again.');
    return false;
  }
  return true;
}
