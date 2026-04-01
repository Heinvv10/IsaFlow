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
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  const companyId = req.companyId;

  /* ------------------------------------------------------------------ */
  /*  GET — list items or fetch single item                             */
  /* ------------------------------------------------------------------ */
  if (req.method === 'GET') {
    const { id, q, type, active, category_id } = req.query;

    // Single item by id
    if (id) {
      const rows = await sql`
        SELECT i.*, ic.name AS category_name
        FROM items i
        LEFT JOIN item_categories ic ON i.category_id = ic.id
        WHERE i.id = ${String(id)} AND i.company_id = ${companyId}
        LIMIT 1
      ` as Row[];

      if (rows.length === 0) {
        return apiResponse.notFound(res, 'Item', String(id));
      }
      return apiResponse.success(res, rows[0]);
    }

    // Build dynamic conditions
    const conditions: string[] = ['i.company_id = $1'];
    const params: unknown[] = [companyId];
    let paramIdx = 1;

    if (q) {
      paramIdx++;
      const term = `%${String(q)}%`;
      conditions.push(`(i.code ILIKE $${paramIdx} OR i.description ILIKE $${paramIdx})`);
      params.push(term);
    }

    if (type && (type === 'physical' || type === 'service')) {
      paramIdx++;
      conditions.push(`i.item_type = $${paramIdx}`);
      params.push(String(type));
    }

    if (active === 'true') {
      conditions.push('i.is_active = true');
    } else if (active === 'false') {
      conditions.push('i.is_active = false');
    }

    if (category_id) {
      paramIdx++;
      conditions.push(`i.category_id = $${paramIdx}::UUID`);
      params.push(String(category_id));
    }

    // Use tagged template for the common case (no dynamic filters beyond company)
    // For complex filtering we fall back to raw query building.
    // However, Neon's tagged templates don't support dynamic WHERE clauses,
    // so we handle it with parameterised conditions.
    const whereClause = conditions.join(' AND ');

    // Neon serverless driver supports sql`` tagged template only.
    // For dynamic queries we use the approach of selecting all and filtering,
    // or build multiple branches. We'll use a simpler approach with tagged templates.

    let rows: Row[];

    const hasSearch = Boolean(q);
    const hasType = Boolean(type && (type === 'physical' || type === 'service'));
    const hasActive = active === 'true' || active === 'false';
    const hasCategoryId = Boolean(category_id);

    if (hasSearch && hasType && hasCategoryId) {
      const term = `%${String(q)}%`;
      const isActive = active === 'true';
      if (hasActive) {
        rows = await sql`
          SELECT i.*, ic.name AS category_name
          FROM items i LEFT JOIN item_categories ic ON i.category_id = ic.id
          WHERE i.company_id = ${companyId}
            AND i.deleted_at IS NULL
            AND (i.code ILIKE ${term} OR i.description ILIKE ${term})
            AND i.item_type = ${String(type)}
            AND i.category_id = ${String(category_id)}::UUID
            AND i.is_active = ${isActive}
          ORDER BY i.code ASC LIMIT 500
        ` as Row[];
      } else {
        rows = await sql`
          SELECT i.*, ic.name AS category_name
          FROM items i LEFT JOIN item_categories ic ON i.category_id = ic.id
          WHERE i.company_id = ${companyId}
            AND i.deleted_at IS NULL
            AND (i.code ILIKE ${term} OR i.description ILIKE ${term})
            AND i.item_type = ${String(type)}
            AND i.category_id = ${String(category_id)}::UUID
          ORDER BY i.code ASC LIMIT 500
        ` as Row[];
      }
    } else if (hasSearch && hasType) {
      const term = `%${String(q)}%`;
      if (hasActive) {
        const isActive = active === 'true';
        rows = await sql`
          SELECT i.*, ic.name AS category_name
          FROM items i LEFT JOIN item_categories ic ON i.category_id = ic.id
          WHERE i.company_id = ${companyId}
            AND i.deleted_at IS NULL
            AND (i.code ILIKE ${term} OR i.description ILIKE ${term})
            AND i.item_type = ${String(type)}
            AND i.is_active = ${isActive}
          ORDER BY i.code ASC LIMIT 500
        ` as Row[];
      } else {
        rows = await sql`
          SELECT i.*, ic.name AS category_name
          FROM items i LEFT JOIN item_categories ic ON i.category_id = ic.id
          WHERE i.company_id = ${companyId}
            AND i.deleted_at IS NULL
            AND (i.code ILIKE ${term} OR i.description ILIKE ${term})
            AND i.item_type = ${String(type)}
          ORDER BY i.code ASC LIMIT 500
        ` as Row[];
      }
    } else if (hasSearch) {
      const term = `%${String(q)}%`;
      if (hasActive) {
        const isActive = active === 'true';
        rows = await sql`
          SELECT i.*, ic.name AS category_name
          FROM items i LEFT JOIN item_categories ic ON i.category_id = ic.id
          WHERE i.company_id = ${companyId}
            AND i.deleted_at IS NULL
            AND (i.code ILIKE ${term} OR i.description ILIKE ${term})
            AND i.is_active = ${isActive}
          ORDER BY i.code ASC LIMIT 500
        ` as Row[];
      } else {
        rows = await sql`
          SELECT i.*, ic.name AS category_name
          FROM items i LEFT JOIN item_categories ic ON i.category_id = ic.id
          WHERE i.company_id = ${companyId}
            AND i.deleted_at IS NULL
            AND (i.code ILIKE ${term} OR i.description ILIKE ${term})
          ORDER BY i.code ASC LIMIT 500
        ` as Row[];
      }
    } else if (hasType) {
      if (hasActive) {
        const isActive = active === 'true';
        rows = await sql`
          SELECT i.*, ic.name AS category_name
          FROM items i LEFT JOIN item_categories ic ON i.category_id = ic.id
          WHERE i.company_id = ${companyId}
            AND i.deleted_at IS NULL
            AND i.item_type = ${String(type)}
            AND i.is_active = ${isActive}
          ORDER BY i.code ASC LIMIT 500
        ` as Row[];
      } else {
        rows = await sql`
          SELECT i.*, ic.name AS category_name
          FROM items i LEFT JOIN item_categories ic ON i.category_id = ic.id
          WHERE i.company_id = ${companyId}
            AND i.deleted_at IS NULL
            AND i.item_type = ${String(type)}
          ORDER BY i.code ASC LIMIT 500
        ` as Row[];
      }
    } else if (hasCategoryId) {
      if (hasActive) {
        const isActive = active === 'true';
        rows = await sql`
          SELECT i.*, ic.name AS category_name
          FROM items i LEFT JOIN item_categories ic ON i.category_id = ic.id
          WHERE i.company_id = ${companyId}
            AND i.deleted_at IS NULL
            AND i.category_id = ${String(category_id)}::UUID
            AND i.is_active = ${isActive}
          ORDER BY i.code ASC LIMIT 500
        ` as Row[];
      } else {
        rows = await sql`
          SELECT i.*, ic.name AS category_name
          FROM items i LEFT JOIN item_categories ic ON i.category_id = ic.id
          WHERE i.company_id = ${companyId}
            AND i.deleted_at IS NULL
            AND i.category_id = ${String(category_id)}::UUID
          ORDER BY i.code ASC LIMIT 500
        ` as Row[];
      }
    } else if (hasActive) {
      const isActive = active === 'true';
      rows = await sql`
        SELECT i.*, ic.name AS category_name
        FROM items i LEFT JOIN item_categories ic ON i.category_id = ic.id
        WHERE i.company_id = ${companyId}
          AND i.deleted_at IS NULL
          AND i.is_active = ${isActive}
        ORDER BY i.code ASC LIMIT 500
      ` as Row[];
    } else {
      rows = await sql`
        SELECT i.*, ic.name AS category_name
        FROM items i LEFT JOIN item_categories ic ON i.category_id = ic.id
        WHERE i.company_id = ${companyId}
          AND i.deleted_at IS NULL
        ORDER BY i.code ASC LIMIT 500
      ` as Row[];
    }

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

    // Auto-generate code if not provided
    let code = String(body.code || '').trim();
    if (!code) {
      const countRows = await sql`
        SELECT COUNT(*)::int AS cnt FROM items WHERE company_id = ${companyId}
      ` as Row[];
      const nextNum = (Number((countRows[0] as Record<string, number>)?.cnt) || 0) + 1;
      code = `ITEM-${String(nextNum).padStart(4, '0')}`;
    }

    // Check for duplicate code within company
    const dupeCheck = await sql`
      SELECT id FROM items WHERE company_id = ${companyId} AND code = ${code} LIMIT 1
    ` as Row[];
    if (dupeCheck.length > 0) {
      return apiResponse.validationError(res, { code: `Item code '${code}' already exists` });
    }

    const costPrice = Number(body.cost_price) || 0;
    const sellingPriceExcl = Number(body.selling_price_excl) || 0;
    const sellingPriceIncl = Number(body.selling_price_incl) || 0;
    const gpPercent = Number(body.gp_percent) || 0;
    const openingQty = Number(body.opening_qty) || 0;
    const openingCost = Number(body.opening_cost) || 0;
    const openingDate = body.opening_date ? String(body.opening_date) : null;
    const categoryId = body.category_id ? String(body.category_id) : null;
    const isActive = body.is_active !== false;
    const unit = String(body.unit || 'each');
    const vatOnSales = String(body.vat_on_sales || 'standard');
    const vatOnPurchases = String(body.vat_on_purchases || 'standard');
    const salesAccountId = body.sales_account_id ? String(body.sales_account_id) : null;
    const purchasesAccountId = body.purchases_account_id ? String(body.purchases_account_id) : null;
    const notes = body.notes ? String(body.notes) : null;
    const imageUrl = body.image_url ? String(body.image_url) : null;

    const inserted = await sql`
      INSERT INTO items (
        company_id, code, description, item_type, category_id, is_active,
        unit, cost_price, selling_price_excl, selling_price_incl, gp_percent,
        vat_on_sales, vat_on_purchases, sales_account_id, purchases_account_id,
        opening_qty, opening_cost, opening_date, current_qty, notes, image_url
      ) VALUES (
        ${companyId}, ${code}, ${description}, ${itemType},
        ${categoryId}::UUID, ${isActive}, ${unit},
        ${costPrice}, ${sellingPriceExcl}, ${sellingPriceIncl}, ${gpPercent},
        ${vatOnSales}, ${vatOnPurchases},
        ${salesAccountId}::UUID, ${purchasesAccountId}::UUID,
        ${openingQty}, ${openingCost}, ${openingDate},
        ${openingQty}, ${notes}, ${imageUrl}
      ) RETURNING *
    ` as Row[];

    log.info('Item created', { code, description, companyId }, 'accounting');
    return apiResponse.created(res, inserted[0]);
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

    // Verify item belongs to company
    const existing = await sql`
      SELECT id FROM items WHERE id = ${id} AND company_id = ${companyId} LIMIT 1
    ` as Row[];
    if (existing.length === 0) {
      return apiResponse.notFound(res, 'Item', id);
    }

    // If code changed, check for duplicates
    if (body.code !== undefined) {
      const newCode = String(body.code).trim();
      if (newCode) {
        const dupeCheck = await sql`
          SELECT id FROM items
          WHERE company_id = ${companyId} AND code = ${newCode} AND id != ${id}
          LIMIT 1
        ` as Row[];
        if (dupeCheck.length > 0) {
          return apiResponse.validationError(res, { code: `Item code '${newCode}' already exists` });
        }
      }
    }

    const updated = await sql`
      UPDATE items SET
        code              = COALESCE(${body.code !== undefined ? String(body.code) : null}, code),
        description       = COALESCE(${body.description !== undefined ? String(body.description) : null}, description),
        item_type         = COALESCE(${body.item_type !== undefined ? String(body.item_type) : null}, item_type),
        category_id       = COALESCE(${body.category_id !== undefined ? String(body.category_id) : null}::UUID, category_id),
        is_active         = COALESCE(${body.is_active !== undefined ? Boolean(body.is_active) : null}, is_active),
        unit              = COALESCE(${body.unit !== undefined ? String(body.unit) : null}, unit),
        cost_price        = COALESCE(${body.cost_price !== undefined ? Number(body.cost_price) : null}, cost_price),
        selling_price_excl = COALESCE(${body.selling_price_excl !== undefined ? Number(body.selling_price_excl) : null}, selling_price_excl),
        selling_price_incl = COALESCE(${body.selling_price_incl !== undefined ? Number(body.selling_price_incl) : null}, selling_price_incl),
        gp_percent        = COALESCE(${body.gp_percent !== undefined ? Number(body.gp_percent) : null}, gp_percent),
        vat_on_sales      = COALESCE(${body.vat_on_sales !== undefined ? String(body.vat_on_sales) : null}, vat_on_sales),
        vat_on_purchases  = COALESCE(${body.vat_on_purchases !== undefined ? String(body.vat_on_purchases) : null}, vat_on_purchases),
        sales_account_id  = COALESCE(${body.sales_account_id !== undefined ? String(body.sales_account_id) : null}::UUID, sales_account_id),
        purchases_account_id = COALESCE(${body.purchases_account_id !== undefined ? String(body.purchases_account_id) : null}::UUID, purchases_account_id),
        opening_qty       = COALESCE(${body.opening_qty !== undefined ? Number(body.opening_qty) : null}, opening_qty),
        opening_cost      = COALESCE(${body.opening_cost !== undefined ? Number(body.opening_cost) : null}, opening_cost),
        opening_date      = COALESCE(${body.opening_date !== undefined ? String(body.opening_date) : null}, opening_date),
        current_qty       = COALESCE(${body.current_qty !== undefined ? Number(body.current_qty) : null}, current_qty),
        notes             = COALESCE(${body.notes !== undefined ? String(body.notes) : null}, notes),
        image_url         = COALESCE(${body.image_url !== undefined ? String(body.image_url) : null}, image_url),
        updated_at        = NOW()
      WHERE id = ${id} AND company_id = ${companyId}
      RETURNING *
    ` as Row[];

    log.info('Item updated', { id, companyId }, 'accounting');
    return apiResponse.success(res, updated[0]);
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

    const existing = await sql`
      SELECT id FROM items WHERE id = ${id} AND company_id = ${companyId} LIMIT 1
    ` as Row[];
    if (existing.length === 0) {
      return apiResponse.notFound(res, 'Item', id);
    }

    await sql`
      UPDATE items SET is_active = false, updated_at = NOW()
      WHERE id = ${id} AND company_id = ${companyId}
    `;

    log.info('Item soft-deleted', { id, companyId }, 'accounting');
    return apiResponse.success(res, { id, deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'PUT', 'DELETE']);
}

export default withCompany(withErrorHandler(handler));
