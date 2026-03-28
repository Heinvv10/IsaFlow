/**
 * Item Categories API — CRUD for item_categories
 * GET:    list all categories for the company
 * POST:   create category
 * PUT:    update category
 * DELETE: delete category
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  const companyId = req.companyId;

  /* ------------------------------------------------------------------ */
  /*  GET — list categories                                             */
  /* ------------------------------------------------------------------ */
  if (req.method === 'GET') {
    const categories = await sql`
      SELECT id, name, description, company_id, created_at, updated_at
      FROM item_categories
      WHERE company_id = ${companyId}
      ORDER BY name ASC
    ` as Row[];

    return apiResponse.success(res, categories);
  }

  /* ------------------------------------------------------------------ */
  /*  POST — create category                                            */
  /* ------------------------------------------------------------------ */
  if (req.method === 'POST') {
    const body = req.body as Record<string, unknown>;
    const name = String(body.name || '').trim();

    if (!name) {
      return apiResponse.validationError(res, { name: 'Category name is required' });
    }

    // Check for duplicate name within company
    const dupeCheck = await sql`
      SELECT id FROM item_categories
      WHERE company_id = ${companyId} AND LOWER(name) = LOWER(${name})
      LIMIT 1
    ` as Row[];
    if (dupeCheck.length > 0) {
      return apiResponse.validationError(res, { name: `Category '${name}' already exists` });
    }

    const description = body.description ? String(body.description) : null;

    const inserted = await sql`
      INSERT INTO item_categories (company_id, name, description)
      VALUES (${companyId}, ${name}, ${description})
      RETURNING *
    ` as Row[];

    log.info('Item category created', { name, companyId }, 'accounting');
    return apiResponse.created(res, inserted[0]);
  }

  /* ------------------------------------------------------------------ */
  /*  PUT — update category                                             */
  /* ------------------------------------------------------------------ */
  if (req.method === 'PUT') {
    const body = req.body as Record<string, unknown>;
    const id = String(body.id || '');
    if (!id) {
      return apiResponse.validationError(res, { id: 'Category id is required' });
    }

    const existing = await sql`
      SELECT id FROM item_categories WHERE id = ${id} AND company_id = ${companyId} LIMIT 1
    ` as Row[];
    if (existing.length === 0) {
      return apiResponse.notFound(res, 'Item Category', id);
    }

    const name = body.name !== undefined ? String(body.name).trim() : null;
    const description = body.description !== undefined ? String(body.description) : null;

    if (name) {
      const dupeCheck = await sql`
        SELECT id FROM item_categories
        WHERE company_id = ${companyId} AND LOWER(name) = LOWER(${name}) AND id != ${id}
        LIMIT 1
      ` as Row[];
      if (dupeCheck.length > 0) {
        return apiResponse.validationError(res, { name: `Category '${name}' already exists` });
      }
    }

    const updated = await sql`
      UPDATE item_categories SET
        name        = COALESCE(${name}, name),
        description = COALESCE(${description}, description),
        updated_at  = NOW()
      WHERE id = ${id} AND company_id = ${companyId}
      RETURNING *
    ` as Row[];

    log.info('Item category updated', { id, companyId }, 'accounting');
    return apiResponse.success(res, updated[0]);
  }

  /* ------------------------------------------------------------------ */
  /*  DELETE — delete category                                          */
  /* ------------------------------------------------------------------ */
  if (req.method === 'DELETE') {
    const body = req.body as Record<string, unknown>;
    const id = String(body.id || '');
    if (!id) {
      return apiResponse.validationError(res, { id: 'Category id is required' });
    }

    const existing = await sql`
      SELECT id FROM item_categories WHERE id = ${id} AND company_id = ${companyId} LIMIT 1
    ` as Row[];
    if (existing.length === 0) {
      return apiResponse.notFound(res, 'Item Category', id);
    }

    // Check if any items reference this category
    const usageCheck = await sql`
      SELECT id FROM items WHERE category_id = ${id} AND company_id = ${companyId} LIMIT 1
    ` as Row[];
    if (usageCheck.length > 0) {
      return apiResponse.badRequest(res, 'Cannot delete category — items are still assigned to it');
    }

    await sql`
      DELETE FROM item_categories WHERE id = ${id} AND company_id = ${companyId}
    `;

    log.info('Item category deleted', { id, companyId }, 'accounting');
    return apiResponse.success(res, { id, deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'PUT', 'DELETE']);
}

export default withCompany(withErrorHandler(handler as any));
