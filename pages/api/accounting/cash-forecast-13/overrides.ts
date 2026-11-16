/**
 * 13-week cash forecast: week overrides (migration 999i, service cashForecast13/overridesRepo).
 * GET                    → { overrides }: every override of the company, by week then line. Any member.
 * PUT    { lineKey, weekStart, mode, amount, targetWeekStart?, note? } → 200 { override, created }
 *        UPSERT on (lineKey, weekStart): a second save of a cell replaces the first (never 409).
 *        weekStart / targetWeekStart are Mondays; set: amount >= 0; add: amount != 0 (signed);
 *        move_to: amount > 0 and a target week other than weekStart; only move_to takes a target.
 * DELETE ?id=<uuid>      → 200 { id }; 404 for an id not of the company
 * Writes: owner/admin/manager + CSRF; a Login-as session is refused (403) before any write; one audit row
 * (entity_type 'cash_forecast_override') per write, in the request transaction.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { isUuidParam } from '@/lib/validation';
import { OverrideInput } from '@/modules/accounting/services/cashForecast13/storeSchemas';
import { deleteOverride, listOverrides, saveOverride } from '@/modules/accounting/services/cashForecast13/overridesRepo';
import { respondCashForecastStoreError } from '@/modules/accounting/services/cashForecast13/storeErrors';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const method = req.method ?? 'GET';
  try {
    if (method === 'GET') return apiResponse.success(res, { overrides: await listOverrides(companyId) });
    if (method === 'PUT') {
      const parsed = OverrideInput.safeParse(req.body ?? {});
      if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid request', parsed.error.flatten().fieldErrors);
      return apiResponse.success(res, await saveOverride(companyId, userId, parsed.data), 'Override saved');
    }
    if (method === 'DELETE') {
      const { id } = req.query;
      if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be an override id');
      await deleteOverride(companyId, userId, id);
      return apiResponse.success(res, { id }, 'Override removed');
    }
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (respondCashForecastStoreError(res, err)) return;
    throw err;
  }
  return apiResponse.methodNotAllowed(res, method, ['GET', 'PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
