/**
 * Asset Depreciation API — Enhanced FAR Engine (Phase 2)
 * POST — run dual policy + tax depreciation for all eligible assets.
 * Writes per-period results to asset_period_ledger and posts policy dep to GL.
 *
 * The logic lives in `services/items/depreciationRunService` so the MCP tool
 * `run_depreciation` can reach it — tools never write SQL, and a second copy of
 * the loop would be free to drift from this one. This route is now the HTTP
 * shell over that service and nothing else.
 *
 * ONE BEHAVIOUR CHANGE came with the extraction: a run whose period is closed,
 * or which no fiscal period covers, is now REFUSED with 400 rather than posted.
 * `postAssetDepreciationToGLThrows` INSERTs at status `posted` and so never
 * reached `postJournalEntry`'s closed-period check.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  runDepreciation,
  defaultPeriodDate,
  DepreciationRunBlockedError,
} from '@/modules/accounting/services/items/depreciationRunService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { companyId } = req as CompanyAuthedRequest;
  const userId = String(req.user.id);

  // periodDate defaults to the last day of the current month; it can be
  // overridden for a historical run, and now actually decides the journal's
  // date and entry number rather than only the subledger period.
  const { periodDate: periodDateParam } = req.body as { periodDate?: string };
  const periodDate = periodDateParam ?? defaultPeriodDate();

  try {
    return apiResponse.success(res, await runDepreciation(companyId, userId, periodDate));
  } catch (err) {
    if (err instanceof DepreciationRunBlockedError) {
      return apiResponse.badRequest(res, err.blocker.detail);
    }
    throw err;
  }
}

export default withAuth(withRole('admin')(withErrorHandler(withCsrf(handler))));
