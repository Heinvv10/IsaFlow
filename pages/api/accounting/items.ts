/**
 * Items API — CRUD for inventory / service items
 * GET:    list items (with filters) or single item (?id=UUID)
 * POST:   create new item
 * PUT:    update existing item
 * DELETE: soft-delete (set is_active = false)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import {
  getItem,
  listItems,
  createItem,
  updateItem,
  softDeleteItem,
  itemExists,
  checkCodeDuplicate,
  type ItemFilters,
  type CreateItemInput,
  type UpdateItemInput,
} from '@/modules/accounting/services/itemService';

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  const companyId = req.companyId;

  /* ------------------------------------------------------------------ */
  /*  GET — list items or fetch single item                             */
  /* ------------------------------------------------------------------ */
  if (req.method === 'GET') {
    const { id, q, type, active, category_id } = req.query;

    if (id) {
      const item = await getItem(companyId, String(id));
      if (!item) return apiResponse.notFound(res, 'Item', String(id));
      return apiResponse.success(res, item);
    }

    const rawType = String(type || '');
    const filters: ItemFilters = {
      q: q ? String(q) : undefined,
      type: rawType === 'physical' || rawType === 'service' ? rawType : undefined,
      active: active === 'true' ? 'true' : active === 'false' ? 'false' : undefined,
      category_id: category_id ? String(category_id) : undefined,
    };

    const rows = await listItems(companyId, filters);
    return apiResponse.success(res, rows);
  }

  /* ------------------------------------------------------------------ */
  /*  POST — create item                                                */
  /* ------------------------------------------------------------------ */
  if (req.method === 'POST') {
    const body = req.body as Record<string, unknown>;

    const description = String(body.description || '').trim();
    if (!description) {
      return apiResponse.validationError(res, { description: 'Description is required' });
    }

    const itemType = String(body.item_type || 'physical');
    if (itemType !== 'physical' && itemType !== 'service') {
      return apiResponse.validationError(res, { item_type: 'Must be physical or service' });
    }

    const code = String(body.code || '').trim();
    if (code) {
      const isDupe = await checkCodeDuplicate(companyId, code);
      if (isDupe) {
        return apiResponse.validationError(res, { code: `Item code '${code}' already exists` });
      }
    }

    const input: CreateItemInput = {
      code: code || undefined,
      description,
      item_type: itemType,
      category_id: body.category_id ? String(body.category_id) : null,
      is_active: body.is_active !== false,
      unit: String(body.unit || 'each'),
      cost_price: Number(body.cost_price) || 0,
      selling_price_excl: Number(body.selling_price_excl) || 0,
      selling_price_incl: Number(body.selling_price_incl) || 0,
      gp_percent: Number(body.gp_percent) || 0,
      vat_on_sales: String(body.vat_on_sales || 'standard'),
      vat_on_purchases: String(body.vat_on_purchases || 'standard'),
      sales_account_id: body.sales_account_id ? String(body.sales_account_id) : null,
      purchases_account_id: body.purchases_account_id ? String(body.purchases_account_id) : null,
      opening_qty: Number(body.opening_qty) || 0,
      opening_cost: Number(body.opening_cost) || 0,
      opening_date: body.opening_date ? String(body.opening_date) : null,
      notes: body.notes ? String(body.notes) : null,
      image_url: body.image_url ? String(body.image_url) : null,
    };

    const item = await createItem(companyId, input);
    return apiResponse.created(res, item);
  }

  /* ------------------------------------------------------------------ */
  /*  PUT — update item                                                 */
  /* ------------------------------------------------------------------ */
  if (req.method === 'PUT') {
    const body = req.body as Record<string, unknown>;
    const id = String(body.id || '');
    if (!id) {
      return apiResponse.validationError(res, { id: 'Item id is required' });
    }

    const exists = await itemExists(companyId, id);
    if (!exists) return apiResponse.notFound(res, 'Item', id);

    if (body.code !== undefined) {
      const newCode = String(body.code).trim();
      if (newCode) {
        const isDupe = await checkCodeDuplicate(companyId, newCode, id);
        if (isDupe) {
          return apiResponse.validationError(res, { code: `Item code '${newCode}' already exists` });
        }
      }
    }

    const input: UpdateItemInput = { id };
    if (body.code !== undefined) input.code = String(body.code);
    if (body.description !== undefined) input.description = String(body.description);
    if (body.item_type !== undefined) input.item_type = String(body.item_type);
    if (body.category_id !== undefined) input.category_id = String(body.category_id);
    if (body.is_active !== undefined) input.is_active = Boolean(body.is_active);
    if (body.unit !== undefined) input.unit = String(body.unit);
    if (body.cost_price !== undefined) input.cost_price = Number(body.cost_price);
    if (body.selling_price_excl !== undefined) input.selling_price_excl = Number(body.selling_price_excl);
    if (body.selling_price_incl !== undefined) input.selling_price_incl = Number(body.selling_price_incl);
    if (body.gp_percent !== undefined) input.gp_percent = Number(body.gp_percent);
    if (body.vat_on_sales !== undefined) input.vat_on_sales = String(body.vat_on_sales);
    if (body.vat_on_purchases !== undefined) input.vat_on_purchases = String(body.vat_on_purchases);
    if (body.sales_account_id !== undefined) input.sales_account_id = String(body.sales_account_id);
    if (body.purchases_account_id !== undefined) input.purchases_account_id = String(body.purchases_account_id);
    if (body.opening_qty !== undefined) input.opening_qty = Number(body.opening_qty);
    if (body.opening_cost !== undefined) input.opening_cost = Number(body.opening_cost);
    if (body.opening_date !== undefined) input.opening_date = String(body.opening_date);
    if (body.current_qty !== undefined) input.current_qty = Number(body.current_qty);
    if (body.notes !== undefined) input.notes = String(body.notes);
    if (body.image_url !== undefined) input.image_url = String(body.image_url);

    const updated = await updateItem(companyId, input);
    return apiResponse.success(res, updated);
  }

  /* ------------------------------------------------------------------ */
  /*  DELETE — soft-delete (set is_active = false)                      */
  /* ------------------------------------------------------------------ */
  if (req.method === 'DELETE') {
    const body = req.body as Record<string, unknown>;
    const id = String(body.id || '');
    if (!id) {
      return apiResponse.validationError(res, { id: 'Item id is required' });
    }

    const exists = await itemExists(companyId, id);
    if (!exists) return apiResponse.notFound(res, 'Item', id);

    await softDeleteItem(companyId, id);
    return apiResponse.success(res, { id, deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'PUT', 'DELETE']);
}

export default withCompany(withErrorHandler(handler as any));
