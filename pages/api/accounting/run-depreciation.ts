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
 * THREE BEHAVIOUR CHANGES came with the extraction, all refusals this route
 * should always have made:
 *  - A run whose period is closed, or which no fiscal period covers, is REFUSED
 *    with 400 rather than posted. `postAssetDepreciationToGLThrows` INSERTs at
 *    status `posted` and so never reached `postJournalEntry`'s check.
 *  - A `periodDate` that is not a canonical YYYY-MM-DD calendar day is refused
 *    with 400 rather than reaching a DATE column and a sliced entry number.
 *  - An asset acquired AFTER the period being run is skipped rather than
 *    charged a full month for a month in which it did not exist.
 *
 * `total` now counts every asset considered, so `processed + skipped + glFailed`
 * equals it; `eligible` carries the narrower count this field used to hold.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  runDepreciation,
  defaultPeriodDate,
  invalidPeriodDate,
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

  // The route used to pass req.body.periodDate straight through. Garbage gave a
  // 500, and a value Postgres accepts but that is not canonical — '2026-9-30' —
  // produced entry number DEP-<asset>-2026-9-, which does not collide with
  // DEP-<asset>-2026-09: a second September journal the already-posted guard
  // never sees. The check is the service's, so this route and the MCP tool
  // cannot drift apart on it.
  const badDate = invalidPeriodDate(periodDate);
  if (badDate) return apiResponse.badRequest(res, badDate.detail);

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
