/**
 * Item Opening Balances API
 * GET  — list active stock items with current qty and cost
 * POST — set opening balances (quantity + unit cost)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql, transaction } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT id, item_code, name, category, uom, qty_available, standard_cost, list_price
        FROM stock_items WHERE is_active = true ORDER BY name
      `;
      return apiResponse.success(res, rows);
    } catch (err) {
      log.error('Failed to fetch items for opening balances', { error: err });
      return apiResponse.badRequest(res, 'Failed to fetch items');
    }
  }

  if (req.method === 'POST') {
    try {
      const { items } = req.body as {
        items?: { itemId: string; quantity: number; unitCost: number }[];
      };

      if (!items || !Array.isArray(items) || items.length === 0) {
        return apiResponse.badRequest(res, 'items array is required');
      }

      for (const entry of items) {
        if (!entry.itemId || entry.quantity == null || entry.unitCost == null) {
          return apiResponse.badRequest(res, 'Each entry needs itemId, quantity, and unitCost');
        }
      }

      await transaction((txSql) =>
        items.map((entry) =>
          txSql`
            UPDATE stock_items
            SET qty_available = ${Number(entry.quantity)},
                standard_cost = ${Number(entry.unitCost)}
            WHERE id = ${entry.itemId}
          `
        )
      );

      log.info('Item opening balances set', { count: items.length });
      return apiResponse.success(res, { updated: items.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to set opening balances';
      log.error('Item opening balances failed', { error: err });
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler));
