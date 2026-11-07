/**
 * Item Pricing API
 * GET — list active stock items with prices
 * PUT — bulk update selling prices
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
  missingStockItemIds,
  nonNegativeAmount,
  stockItemBatchIds,
} from '@/modules/accounting/services/items/stockItemLookup';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyId = (req as CompanyAuthedRequest).companyId;

  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT id, item_code, name, category, uom, list_price, standard_cost, qty_available
        FROM stock_items WHERE company_id = ${companyId} AND is_active = true ORDER BY name
      `;
      return apiResponse.success(res, rows);
    } catch (err) {
      log.error('Failed to fetch item pricing', { error: err });
      return apiResponse.badRequest(res, 'Failed to fetch item pricing');
    }
  }

  if (req.method === 'PUT') {
    try {
      const { updates } = req.body as {
        updates?: { itemId: string; sellingPrice: number }[];
      };

      if (!updates || !Array.isArray(updates) || updates.length === 0) {
        return apiResponse.badRequest(res, 'updates array is required');
      }

      // Everything is checked before the one UPDATE: withAuth commits a 4xx,
      // so the old per-entry loop's 404 left the earlier prices written.
      const batch = stockItemBatchIds(updates.map((u) => u?.itemId));
      if ('error' in batch) return apiResponse.badRequest(res, batch.error);
      const prices = updates.map((u) => nonNegativeAmount(u.sellingPrice));
      if (prices.includes(null)) return apiResponse.badRequest(res, 'Each entry needs a sellingPrice of zero or more');
      const missing = await missingStockItemIds(companyId, batch.ids);
      if (missing.length > 0) return apiResponse.notFound(res, 'Stock item', describeMissing(missing));

      const updated = (await sql`
        UPDATE stock_items s
        SET list_price = v.price
        FROM unnest(${batch.ids}::UUID[], ${prices}::NUMERIC[]) AS v(id, price)
        WHERE s.id = v.id AND s.company_id = ${companyId}::UUID
        RETURNING s.id
      `) as unknown[];

      log.info('Selling prices updated', { count: updated.length });
      return apiResponse.success(res, { updated: updated.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update prices';
      log.error('Item pricing update failed', { error: err });
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
