/**
 * Item Service — CRUD for inventory / service items
 * All queries are scoped to company_id for multi-tenant safety.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
type Row = Record<string, unknown>;


export interface ItemFilters {
  q?: string;
  type?: 'physical' | 'service';
  active?: 'true' | 'false';
  category_id?: string;
}

export interface CreateItemInput {
  code?: string;
  description: string;
  item_type?: string;
  category_id?: string | null;
  is_active?: boolean;
  unit?: string;
  cost_price?: number;
  selling_price_excl?: number;
  selling_price_incl?: number;
  gp_percent?: number;
  vat_on_sales?: string;
  vat_on_purchases?: string;
  sales_account_id?: string | null;
  purchases_account_id?: string | null;
  opening_qty?: number;
  opening_cost?: number;
  opening_date?: string | null;
  notes?: string | null;
  image_url?: string | null;
}

export interface UpdateItemInput {
  id: string;
  code?: string;
  description?: string;
  item_type?: string;
  category_id?: string;
  is_active?: boolean;
  unit?: string;
  cost_price?: number;
  selling_price_excl?: number;
  selling_price_incl?: number;
  gp_percent?: number;
  vat_on_sales?: string;
  vat_on_purchases?: string;
  sales_account_id?: string;
  purchases_account_id?: string;
  opening_qty?: number;
  opening_cost?: number;
  opening_date?: string;
  current_qty?: number;
  notes?: string;
  image_url?: string;
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function getItem(companyId: string, itemId: string): Promise<Row | null> {
  const rows = await sql`
    SELECT i.*, ic.name AS category_name
    FROM items i
    LEFT JOIN item_categories ic ON i.category_id = ic.id
    WHERE i.id = ${itemId} AND i.company_id = ${companyId}
    LIMIT 1
  ` as Row[];
  return rows[0] ?? null;
}

export async function listItems(companyId: string, filters: ItemFilters = {}): Promise<Row[]> {
  const { q, type, active, category_id } = filters;

  // Validate and build safe extra conditions (all values are validated before use)
  const extraParts: string[] = [];

  if (type === 'physical' || type === 'service') {
    // type is a validated enum — safe to embed
    extraParts.push(`AND i.item_type = '${type}'`);
  }

  if (active === 'true') {
    extraParts.push('AND i.is_active = true');
  } else if (active === 'false') {
    extraParts.push('AND i.is_active = false');
  }

  const extraSql = extraParts.join(' ');

  // Branch on the two parameterised filter dimensions (search term + category_id)
  // using sql.unsafe only for pre-validated, non-user-interpolated fragments.
  if (q && category_id) {
    const term = `%${q}%`;
    return sql`
      SELECT i.*, ic.name AS category_name
      FROM items i LEFT JOIN item_categories ic ON i.category_id = ic.id
      WHERE i.company_id = ${companyId}
        AND i.deleted_at IS NULL
        AND (i.code ILIKE ${term} OR i.description ILIKE ${term})
        AND i.category_id = ${category_id}::UUID
        ${sql.unsafe(extraSql)}
      ORDER BY i.code ASC LIMIT 500
    ` as Promise<Row[]>;
  }

  if (q) {
    const term = `%${q}%`;
    return sql`
      SELECT i.*, ic.name AS category_name
      FROM items i LEFT JOIN item_categories ic ON i.category_id = ic.id
      WHERE i.company_id = ${companyId}
        AND i.deleted_at IS NULL
        AND (i.code ILIKE ${term} OR i.description ILIKE ${term})
        ${sql.unsafe(extraSql)}
      ORDER BY i.code ASC LIMIT 500
    ` as Promise<Row[]>;
  }

  if (category_id) {
    return sql`
      SELECT i.*, ic.name AS category_name
      FROM items i LEFT JOIN item_categories ic ON i.category_id = ic.id
      WHERE i.company_id = ${companyId}
        AND i.deleted_at IS NULL
        AND i.category_id = ${category_id}::UUID
        ${sql.unsafe(extraSql)}
      ORDER BY i.code ASC LIMIT 500
    ` as Promise<Row[]>;
  }

  return sql`
    SELECT i.*, ic.name AS category_name
    FROM items i LEFT JOIN item_categories ic ON i.category_id = ic.id
    WHERE i.company_id = ${companyId}
      AND i.deleted_at IS NULL
      ${sql.unsafe(extraSql)}
    ORDER BY i.code ASC LIMIT 500
  ` as Promise<Row[]>;
}

// ── Validation helpers ────────────────────────────────────────────────────────

async function generateItemCode(companyId: string): Promise<string> {
  const countRows = await sql`
    SELECT COUNT(*)::int AS cnt FROM items WHERE company_id = ${companyId}
  ` as Row[];
  const nextNum = (Number((countRows[0] as Row)?.cnt) || 0) + 1;
  return `ITEM-${String(nextNum).padStart(4, '0')}`;
}

export async function checkCodeDuplicate(
  companyId: string,
  code: string,
  excludeId?: string
): Promise<boolean> {
  if (excludeId) {
    const rows = await sql`
      SELECT id FROM items
      WHERE company_id = ${companyId} AND code = ${code} AND id != ${excludeId}
      LIMIT 1
    ` as Row[];
    return rows.length > 0;
  }
  const rows = await sql`
    SELECT id FROM items WHERE company_id = ${companyId} AND code = ${code} LIMIT 1
  ` as Row[];
  return rows.length > 0;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function createItem(companyId: string, input: CreateItemInput): Promise<Row> {
  const code = input.code?.trim() || (await generateItemCode(companyId));
  const itemType = input.item_type || 'physical';
  const categoryId = input.category_id ?? null;
  const salesAccountId = input.sales_account_id ?? null;
  const purchasesAccountId = input.purchases_account_id ?? null;
  const costPrice = input.cost_price ?? 0;
  const sellingPriceExcl = input.selling_price_excl ?? 0;
  const sellingPriceIncl = input.selling_price_incl ?? 0;
  const gpPercent = input.gp_percent ?? 0;
  const openingQty = input.opening_qty ?? 0;
  const openingCost = input.opening_cost ?? 0;
  const openingDate = input.opening_date ?? null;
  const isActive = input.is_active !== false;
  const unit = input.unit || 'each';
  const vatOnSales = input.vat_on_sales || 'standard';
  const vatOnPurchases = input.vat_on_purchases || 'standard';
  const notes = input.notes ?? null;
  const imageUrl = input.image_url ?? null;

  const inserted = await sql`
    INSERT INTO items (
      company_id, code, description, item_type, category_id, is_active,
      unit, cost_price, selling_price_excl, selling_price_incl, gp_percent,
      vat_on_sales, vat_on_purchases, sales_account_id, purchases_account_id,
      opening_qty, opening_cost, opening_date, current_qty, notes, image_url
    ) VALUES (
      ${companyId}, ${code}, ${input.description}, ${itemType},
      ${categoryId}::UUID, ${isActive}, ${unit},
      ${costPrice}, ${sellingPriceExcl}, ${sellingPriceIncl}, ${gpPercent},
      ${vatOnSales}, ${vatOnPurchases},
      ${salesAccountId}::UUID, ${purchasesAccountId}::UUID,
      ${openingQty}, ${openingCost}, ${openingDate},
      ${openingQty}, ${notes}, ${imageUrl}
    ) RETURNING *
  ` as Row[];

  log.info('Item created', { code, description: input.description, companyId }, 'accounting');
  return inserted[0]!;
}

export async function updateItem(companyId: string, input: UpdateItemInput): Promise<Row> {
  const { id } = input;

  const updated = await sql`
    UPDATE items SET
      code               = COALESCE(${input.code !== undefined ? String(input.code) : null}, code),
      description        = COALESCE(${input.description !== undefined ? String(input.description) : null}, description),
      item_type          = COALESCE(${input.item_type !== undefined ? String(input.item_type) : null}, item_type),
      category_id        = COALESCE(${input.category_id !== undefined ? String(input.category_id) : null}::UUID, category_id),
      is_active          = COALESCE(${input.is_active !== undefined ? Boolean(input.is_active) : null}, is_active),
      unit               = COALESCE(${input.unit !== undefined ? String(input.unit) : null}, unit),
      cost_price         = COALESCE(${input.cost_price !== undefined ? Number(input.cost_price) : null}, cost_price),
      selling_price_excl = COALESCE(${input.selling_price_excl !== undefined ? Number(input.selling_price_excl) : null}, selling_price_excl),
      selling_price_incl = COALESCE(${input.selling_price_incl !== undefined ? Number(input.selling_price_incl) : null}, selling_price_incl),
      gp_percent         = COALESCE(${input.gp_percent !== undefined ? Number(input.gp_percent) : null}, gp_percent),
      vat_on_sales       = COALESCE(${input.vat_on_sales !== undefined ? String(input.vat_on_sales) : null}, vat_on_sales),
      vat_on_purchases   = COALESCE(${input.vat_on_purchases !== undefined ? String(input.vat_on_purchases) : null}, vat_on_purchases),
      sales_account_id   = COALESCE(${input.sales_account_id !== undefined ? String(input.sales_account_id) : null}::UUID, sales_account_id),
      purchases_account_id = COALESCE(${input.purchases_account_id !== undefined ? String(input.purchases_account_id) : null}::UUID, purchases_account_id),
      opening_qty        = COALESCE(${input.opening_qty !== undefined ? Number(input.opening_qty) : null}, opening_qty),
      opening_cost       = COALESCE(${input.opening_cost !== undefined ? Number(input.opening_cost) : null}, opening_cost),
      opening_date       = COALESCE(${input.opening_date !== undefined ? String(input.opening_date) : null}, opening_date),
      current_qty        = COALESCE(${input.current_qty !== undefined ? Number(input.current_qty) : null}, current_qty),
      notes              = COALESCE(${input.notes !== undefined ? String(input.notes) : null}, notes),
      image_url          = COALESCE(${input.image_url !== undefined ? String(input.image_url) : null}, image_url),
      updated_at         = NOW()
    WHERE id = ${id} AND company_id = ${companyId}
    RETURNING *
  ` as Row[];

  log.info('Item updated', { id, companyId }, 'accounting');
  return updated[0]!;
}

export async function softDeleteItem(companyId: string, itemId: string): Promise<void> {
  await sql`
    UPDATE items SET is_active = false, updated_at = NOW()
    WHERE id = ${itemId} AND company_id = ${companyId}
  `;
  log.info('Item soft-deleted', { id: itemId, companyId }, 'accounting');
}

export async function itemExists(companyId: string, itemId: string): Promise<boolean> {
  const rows = await sql`
    SELECT id FROM items WHERE id = ${itemId} AND company_id = ${companyId} LIMIT 1
  ` as Row[];
  return rows.length > 0;
}
