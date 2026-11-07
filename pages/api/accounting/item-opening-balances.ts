/**
 * Item Opening Balances API
 * GET  — list active stock items with current qty and cost
 * POST — set opening balances (quantity + unit cost)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import {
  describeMissing,
  assertEveryItemUpdated,
  missingStockItemIds,
  nonNegativeAmount,
  stockItemBatchIds,
} from '@/modules/accounting/services/items/stockItemLookup';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT id, item_code, name, category, uom, qty_available, standard_cost, list_price
        FROM stock_items WHERE is_active = true AND company_id = ${companyId} ORDER BY name
      `;
      return apiResponse.success(res, rows);
    } catch (err) {
      log.error('Failed to fetch items for opening balances', { error: err });
      return apiResponse.badRequest(res, 'Failed to fetch items');
    }
  }

  if (req.method === 'POST') {
    const { items } = (req.body ?? {}) as {
      items?: { itemId: string; quantity: number; unitCost: number }[];
    };

    if (!items || !Array.isArray(items) || items.length === 0) {
      return apiResponse.badRequest(res, 'items array is required');
    }

    // No catch here: a throw must reach withErrorHandler as a 500, which withAuth
    // rolls back. Everything is checked before the one UPDATE: withAuth commits a 4xx,
    // and the count returned used to be the request's length even when an
    // id matched no stock item of this company.
    const batch = stockItemBatchIds(items.map((e) => e?.itemId));
    if ('error' in batch) return apiResponse.badRequest(res, batch.error);
    const quantities = items.map((e) => nonNegativeAmount(e.quantity));
    const costs = items.map((e) => nonNegativeAmount(e.unitCost));
    if (quantities.includes(null) || costs.includes(null)) {
      return apiResponse.badRequest(res, 'Each entry needs a quantity and unitCost of zero or more');
    }
    const missing = await missingStockItemIds(companyId, batch.ids);
    if (missing.length > 0) return apiResponse.notFound(res, 'Stock item', describeMissing(missing));

    const updated = (await sql`
      UPDATE stock_items s
      SET qty_available = v.qty, standard_cost = v.cost
      FROM unnest(${batch.ids}::UUID[], ${quantities}::NUMERIC[], ${costs}::NUMERIC[]) AS v(id, qty, cost)
      WHERE s.id = v.id AND s.company_id = ${companyId}::UUID
      RETURNING s.id
    `) as unknown[];

    assertEveryItemUpdated(updated, batch.ids.length);
    log.info('Item opening balances set', { count: updated.length });
    return apiResponse.success(res, { updated: updated.length });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
