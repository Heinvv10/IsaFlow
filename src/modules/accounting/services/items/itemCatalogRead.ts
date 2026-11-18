/**
 * Item master reads for the MCP item tools: one item by id, code or external reference, and a keyset-paged list.
 * Every query names `company_id`; a soft-deleted item (`deleted_at`) is never returned.
 *
 * The list pages on (code, id) with a row comparison in SQL, so the cursor and the ORDER BY share one collation and a
 * concurrent insert cannot serve a row twice or skip one.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { mapItemRow, type CatalogItem } from './itemCatalogTypes';

export interface ItemListFilters {
  q?: string | null;
  type?: string | null;
  categoryId?: string | null;
  isActive?: boolean | null;
  inventoryTracked?: boolean | null;
  externalSystem?: string | null;
  externalRef?: string | null;
}

export interface ItemPage {
  items: CatalogItem[];
  total: number;
  /** The (code, id) of the last row served when more remain, else null. */
  next: { code: string; id: string } | null;
}

/** A search term as an ILIKE contains-pattern in which %, _ and \ match literally. */
function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

export async function listCatalogItems(
  companyId: string,
  filters: ItemListFilters,
  after: { code: string; id: string } | null,
  limit: number,
): Promise<ItemPage> {
  const term = filters.q ? containsPattern(filters.q) : null;
  const type = filters.type ?? null;
  const categoryId = filters.categoryId ?? null;
  const isActive = filters.isActive ?? null;
  const tracked = filters.inventoryTracked ?? null;
  const system = filters.externalSystem ?? null;
  const ref = filters.externalRef ?? null;

  const [countRow] = (await sql`
    SELECT COUNT(*)::INT AS n FROM items i
    WHERE i.company_id = ${companyId}::UUID AND i.deleted_at IS NULL
      AND (${type}::TEXT IS NULL OR i.item_type = ${type}::TEXT)
      AND (${isActive}::BOOLEAN IS NULL OR i.is_active = ${isActive}::BOOLEAN)
      AND (${tracked}::BOOLEAN IS NULL OR i.inventory_tracked = ${tracked}::BOOLEAN)
      AND (${categoryId}::UUID IS NULL OR i.category_id = ${categoryId}::UUID)
      AND (${term}::TEXT IS NULL OR i.code ILIKE ${term}::TEXT OR i.description ILIKE ${term}::TEXT)
      AND (${system}::TEXT IS NULL OR i.external_system = ${system}::TEXT)
      AND (${ref}::TEXT IS NULL OR i.external_ref = ${ref}::TEXT)
  `) as DbRow[];

  const afterCode = after?.code ?? null;
  const afterId = after?.id ?? null;
  const rows = (await sql`
    SELECT i.*, ic.code AS category_code, ic.name AS category_name
    FROM items i
    LEFT JOIN item_categories ic ON ic.id = i.category_id AND ic.company_id = i.company_id
    WHERE i.company_id = ${companyId}::UUID AND i.deleted_at IS NULL
      AND (${type}::TEXT IS NULL OR i.item_type = ${type}::TEXT)
      AND (${isActive}::BOOLEAN IS NULL OR i.is_active = ${isActive}::BOOLEAN)
      AND (${tracked}::BOOLEAN IS NULL OR i.inventory_tracked = ${tracked}::BOOLEAN)
      AND (${categoryId}::UUID IS NULL OR i.category_id = ${categoryId}::UUID)
      AND (${term}::TEXT IS NULL OR i.code ILIKE ${term}::TEXT OR i.description ILIKE ${term}::TEXT)
      AND (${system}::TEXT IS NULL OR i.external_system = ${system}::TEXT)
      AND (${ref}::TEXT IS NULL OR i.external_ref = ${ref}::TEXT)
      AND (${afterCode}::TEXT IS NULL OR (i.code, i.id) > (${afterCode}::TEXT, ${afterId}::UUID))
    ORDER BY i.code ASC, i.id ASC
    LIMIT ${limit + 1}
  `) as DbRow[];

  const page = rows.slice(0, limit).map(mapItemRow);
  const last = page[page.length - 1];
  return {
    items: page,
    total: Number(countRow?.n) || 0,
    next: rows.length > limit && last ? { code: last.code, id: last.id } : null,
  };
}

export interface ItemLookup {
  id?: string | null;
  code?: string | null;
  externalSystem?: string | null;
  externalRef?: string | null;
}

/** One item by exactly one of: id, code, or (external_system, external_ref). Null when this company has none. */
export async function getCatalogItem(companyId: string, by: ItemLookup): Promise<CatalogItem | null> {
  let rows: DbRow[];
  if (by.id) {
    rows = (await sql`
      SELECT i.*, ic.code AS category_code, ic.name AS category_name
      FROM items i LEFT JOIN item_categories ic ON ic.id = i.category_id AND ic.company_id = i.company_id
      WHERE i.company_id = ${companyId}::UUID AND i.id = ${by.id}::UUID AND i.deleted_at IS NULL`) as DbRow[];
  } else if (by.code) {
    rows = (await sql`
      SELECT i.*, ic.code AS category_code, ic.name AS category_name
      FROM items i LEFT JOIN item_categories ic ON ic.id = i.category_id AND ic.company_id = i.company_id
      WHERE i.company_id = ${companyId}::UUID AND i.code = ${by.code} AND i.deleted_at IS NULL`) as DbRow[];
  } else if (by.externalSystem && by.externalRef) {
    rows = (await sql`
      SELECT i.*, ic.code AS category_code, ic.name AS category_name
      FROM items i LEFT JOIN item_categories ic ON ic.id = i.category_id AND ic.company_id = i.company_id
      WHERE i.company_id = ${companyId}::UUID AND i.external_system = ${by.externalSystem}
        AND i.external_ref = ${by.externalRef} AND i.deleted_at IS NULL`) as DbRow[];
  } else {
    return null;
  }
  return rows[0] ? mapItemRow(rows[0]) : null;
}
