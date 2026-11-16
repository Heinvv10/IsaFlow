/**
 * 13-week cash forecast: expected cash items (migration 999i, service cashForecast13/itemsRepo).
 * GET                    → { items }: every item of the company, by expected date. Any member.
 * POST   { direction, amount, date, repeat?, repeatUntil?, description, category?, accountId? } → 201 item
 *        category: customer_receipts | supplier_payments | payroll | sars | loans | other (default other)
 * PUT    { id, …the same } → 200 item; 404 for an id not of the company
 * DELETE ?id=<uuid>      → 200 { id }; 404 for an id not of the company
 * Writes: owner/admin/manager + CSRF; a Login-as session is refused (403) before any write; one audit row
 * (entity_type 'cash_forecast_item') per write, in the request transaction. 400 for an account of another company.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { isUuidParam } from '@/lib/validation';
import { ItemInput, ItemUpdate } from '@/modules/accounting/services/cashForecast13/storeSchemas';
import { createItem, deleteItem, listItems, updateItem } from '@/modules/accounting/services/cashForecast13/itemsRepo';
import { respondCashForecastStoreError } from '@/modules/accounting/services/cashForecast13/storeErrors';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const method = req.method ?? 'GET';
  try {
    if (method === 'GET') return apiResponse.success(res, { items: await listItems(companyId) });
    if (method === 'POST') {
      const parsed = ItemInput.safeParse(req.body ?? {});
      if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid request', parsed.error.flatten().fieldErrors);
      return apiResponse.created(res, await createItem(companyId, userId, parsed.data), 'Item added');
    }
    if (method === 'PUT') {
      const parsed = ItemUpdate.safeParse(req.body ?? {});
      if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid request', parsed.error.flatten().fieldErrors);
      const { id, ...input } = parsed.data;
      return apiResponse.success(res, await updateItem(companyId, userId, id, input), 'Item updated');
    }
    if (method === 'DELETE') {
      const { id } = req.query;
      if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be an item id');
      await deleteItem(companyId, userId, id);
      return apiResponse.success(res, { id }, 'Item removed');
    }
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (respondCashForecastStoreError(res, err)) return;
    throw err;
  }
  return apiResponse.methodNotAllowed(res, method, ['GET', 'POST', 'PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
