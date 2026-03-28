/**
 * Item Adjustments API
 * GET  — list stock items with current quantities
 * POST — create stock adjustment (increase/decrease)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT id, item_code, name AS item_name, uom, category,
          qty_available AS current_quantity, standard_cost
        FROM stock_items WHERE is_active = true ORDER BY name
      `;
      return apiResponse.success(res, rows);
    } catch (err) {
      log.error('Failed to fetch items for adjustments', { error: err });
      return apiResponse.badRequest(res, 'Failed to fetch items');
    }
  }

  if (req.method === 'POST') {
    try {
      const { itemId, adjustmentType, quantity, reason, date } = req.body as {
        itemId?: string;
        adjustmentType?: 'increase' | 'decrease';
        quantity?: number;
        reason?: string;
        date?: string;
      };

      if (!itemId) return apiResponse.badRequest(res, 'itemId is required');
      if (!adjustmentType || !['increase', 'decrease'].includes(adjustmentType)) {
        return apiResponse.badRequest(res, 'adjustmentType must be increase or decrease');
      }
      if (!quantity || Number(quantity) <= 0) return apiResponse.badRequest(res, 'quantity must be positive');
      if (!reason) return apiResponse.badRequest(res, 'reason is required');

      const [item] = await sql`
        SELECT id, name, qty_available FROM stock_items WHERE id = ${itemId}
      `;
      if (!item) return apiResponse.notFound(res, 'Stock item', itemId);

      const currentQty = Number(item.qty_available || 0);
      const qty = Number(quantity);
      const newQty = adjustmentType === 'increase' ? currentQty + qty : currentQty - qty;

      if (newQty < 0) {
        return apiResponse.badRequest(res, `Cannot decrease by ${qty} — current qty is ${currentQty}`);
      }

      await sql`UPDATE stock_items SET qty_available = ${newQty} WHERE id = ${itemId}`;

      log.info('Stock item adjusted', { itemId, adjustmentType, quantity: qty, newQty });

      return apiResponse.success(res, {
        itemId,
        adjustmentType,
        quantity: qty,
        previousQuantity: currentQty,
        newQuantity: newQty,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Adjustment failed';
      log.error('Item adjustment failed', { error: err });
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withCompany(handler);
