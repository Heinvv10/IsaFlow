/**
 * 13-week cash forecast: week overrides (migration 999i, service cashForecast13/overridesRepo).
 * GET                    → { overrides }: every override of the company, in the order the engine applies them
 *                          (applied_at, id: a cell moves to the end only when its mode, amount or target
 *                          changes; a note-only edit keeps its place). Any member.
 *        A 'manual:<id>' key is stored lowercase; no UUID after it is 400; the item must exist for the company (404).
 * PUT    { lineKey, weekStart, mode, amount, targetWeekStart?, note? } → 200 { override, created }
 *        UPSERT on (lineKey, weekStart): a second save of a cell replaces the first (never 409).
 *        weekStart / targetWeekStart are Mondays; set/add amounts are signed in the line's own sign
 *        (set: required; add: != 0);
 *        move_to: amount > 0 or null (the whole cell) and a target week other than weekStart; only move_to takes a target.
 * DELETE ?id=<uuid>      → 200 { id }; 404 for an id not of the company
 * Writes: owner/admin/manager + CSRF; 120 a minute per user across the three routes (429, Retry-After 60); a Login-as session is refused (403) before any write; one audit row
 * (entity_type 'cash_forecast_override') per write, in the request transaction.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { refuseIfWriteRateLimited } from '@/modules/accounting/services/cashForecast13/writeRateLimit';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { isUuidParam } from '@/lib/validation';
import { OverrideInput } from '@/modules/accounting/services/cashForecast13/storeSchemas';
import { deleteOverride, listOverrides, saveOverride } from '@/modules/accounting/services/cashForecast13/overridesRepo';
import { respondCashForecastStoreError } from '@/modules/accounting/services/cashForecast13/storeErrors';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const method = req.method ?? 'GET';
  // Writes are charged to the user's bucket first (120 a minute across the three cash-forecast routes).
  if (method !== 'GET' && (await refuseIfWriteRateLimited(userId, res))) return;
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
