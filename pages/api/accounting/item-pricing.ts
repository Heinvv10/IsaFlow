/**
 * Item Pricing API
 * GET — list active stock items with prices
 * PUT — bulk update selling prices
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { neon } from '@neondatabase/serverless';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';

const sql = neon(process.env.DATABASE_URL!);

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT id, item_code, name, category, uom, list_price, standard_cost, qty_available
        FROM stock_items WHERE is_active = true ORDER BY name
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

      for (const u of updates) {
        if (!u.itemId || u.sellingPrice == null || Number(u.sellingPrice) < 0) {
          return apiResponse.badRequest(res, 'Each entry needs itemId and non-negative sellingPrice');
        }
      }

      for (const u of updates) {
        await sql`UPDATE stock_items SET list_price = ${Number(u.sellingPrice)} WHERE id = ${u.itemId}`;
      }

      log.info('Selling prices updated', { count: updates.length });
      return apiResponse.success(res, { updated: updates.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update prices';
      log.error('Item pricing update failed', { error: err });
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT']);
}

export default withAuth(handler);
