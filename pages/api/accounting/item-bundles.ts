/**
 * Item Bundles API
 * GET    ?itemId=<id>  — list bundle lines for a parent item
 * POST                 — upsert bundle lines { item_id, lines: [{ child_item_id, quantity }] }
 * DELETE ?itemId=<id>  — remove all bundle lines and clear is_bundle flag
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withWriteAccess } from '@/lib/auth';
import { itemExists } from '@/modules/accounting/services/items/itemService';
import {
  getBundleLines,
  upsertBundleLines,
  deleteBundleLines,
  type BundleLine,
} from '@/modules/accounting/services/items/itemBundleService';

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  const companyId = req.companyId;

  /* ------------------------------------------------------------------ */
  /*  GET — fetch bundle lines for an item                               */
  /* ------------------------------------------------------------------ */
  if (req.method === 'GET') {
    const itemId = req.query.itemId ? String(req.query.itemId) : '';
    if (!itemId) {
      return apiResponse.badRequest(res, 'itemId query parameter is required');
    }
    const exists = await itemExists(companyId, itemId);
    if (!exists) return apiResponse.notFound(res, 'Item', itemId);

    const lines = await getBundleLines(companyId, itemId);
    return apiResponse.success(res, lines);
  }

  /* ------------------------------------------------------------------ */
  /*  POST — upsert bundle lines                                         */
  /* ------------------------------------------------------------------ */
  if (req.method === 'POST') {
    const body = req.body as Record<string, unknown>;
    const itemId = body.item_id ? String(body.item_id) : '';
    if (!itemId) {
      return apiResponse.validationError(res, { item_id: 'item_id is required' });
    }

    const exists = await itemExists(companyId, itemId);
    if (!exists) return apiResponse.notFound(res, 'Item', itemId);

    if (!Array.isArray(body.lines)) {
      return apiResponse.validationError(res, { lines: 'lines must be an array' });
    }

    const rawLines = body.lines as Record<string, unknown>[];
    const lines: BundleLine[] = [];

    for (let i = 0; i < rawLines.length; i++) {
      const l = rawLines[i];
      if (!l) continue;
      const childId = l.child_item_id ? String(l.child_item_id) : '';
      if (!childId) {
        return apiResponse.validationError(res, {
          lines: `Line ${i}: child_item_id is required`,
        });
      }
      if (childId === itemId) {
        return apiResponse.validationError(res, {
          lines: `Line ${i}: an item cannot be a component of itself`,
        });
      }
      const childExists = await itemExists(companyId, childId);
      if (!childExists) {
        return apiResponse.validationError(res, {
          lines: `Line ${i}: child item ${childId} not found`,
        });
      }
      const qty = Number(l.quantity);
      if (!qty || qty <= 0) {
        return apiResponse.validationError(res, {
          lines: `Line ${i}: quantity must be a positive number`,
        });
      }
      lines.push({ child_item_id: childId, quantity: qty, sort_order: i });
    }

    const result = await upsertBundleLines(companyId, itemId, lines);
    return apiResponse.success(res, result);
  }

  /* ------------------------------------------------------------------ */
  /*  DELETE — remove all bundle lines for an item                       */
  /* ------------------------------------------------------------------ */
  if (req.method === 'DELETE') {
    const itemId = req.query.itemId ? String(req.query.itemId) : '';
    if (!itemId) {
      return apiResponse.badRequest(res, 'itemId query parameter is required');
    }
    const exists = await itemExists(companyId, itemId);
    if (!exists) return apiResponse.notFound(res, 'Item', itemId);

    await deleteBundleLines(companyId, itemId);
    return apiResponse.success(res, { item_id: itemId, deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'DELETE']);
}

export default withCompany(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0] )));
