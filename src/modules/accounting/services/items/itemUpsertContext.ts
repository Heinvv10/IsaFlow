/**
 * What `bulk_upsert_items` has to know about the company before it can plan a batch: the items its rows may match (by
 * code or by external reference, soft-deleted ones included, because the code stays unique across them), the
 * company's categories, the GL accounts the rows name, and which of the matched items already have stock movements.
 * Four reads for the whole batch, every one scoped by `company_id`.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { ItemFields } from './itemFieldValidation';
import { ITEM_CODE_SEED, takeCompanyNumberLock } from '../core/numberLock';

export interface ExistingItem {
  id: string;
  code: string;
  deleted: boolean;
  description: string;
  itemType: string;
  unit: string | null;
  categoryId: string | null;
  purchasePrice: number;
  salesPrice: number;
  vatOnSales: string | null;
  vatOnPurchases: string | null;
  salesAccountId: string | null;
  purchasesAccountId: string | null;
  inventoryTracked: boolean;
  isActive: boolean;
  notes: string | null;
  externalSystem: string | null;
  externalRef: string | null;
  externalDocumentNumber: string | null;
}

export interface CategoryRef {
  id: string;
  code: string | null;
  name: string;
  isActive: boolean;
}

export interface UpsertContext {
  byId: Map<string, ExistingItem>;
  byCode: Map<string, ExistingItem>;
  byRef: Map<string, ExistingItem>;
  categories: CategoryRef[];
  /** account id -> is_active, for the accounts of THIS company only (anything else is absent). */
  accounts: Map<string, boolean>;
  /** Items with at least one stock movement, which may not become a service. */
  itemsWithMovements: Set<string>;
}

export const refKey = (system: string, ref: string): string => `${system}\u0000${ref}`;

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function mapExisting(r: DbRow): ExistingItem {
  return {
    id: String(r.id), code: String(r.code), deleted: r.deleted_at !== null && r.deleted_at !== undefined,
    description: String(r.description ?? ''), itemType: String(r.item_type ?? 'physical'), unit: s(r.unit),
    categoryId: s(r.category_id), purchasePrice: Number(r.cost_price) || 0, salesPrice: Number(r.selling_price_excl) || 0,
    vatOnSales: s(r.vat_on_sales), vatOnPurchases: s(r.vat_on_purchases), salesAccountId: s(r.sales_account_id),
    purchasesAccountId: s(r.purchases_account_id), inventoryTracked: r.inventory_tracked === true, isActive: r.is_active !== false,
    notes: s(r.notes), externalSystem: s(r.external_system), externalRef: s(r.external_ref),
    externalDocumentNumber: s(r.external_document_number),
  };
}

export async function loadUpsertContext(
  companyId: string, rows: ItemFields[], extraItemIds: string[] = [],
): Promise<UpsertContext> {
  // One batch at a time per company: two concurrent upserts of the same catalogue would otherwise both plan "create".
  // The bounded number lock (migration 864): a second batch waits at most 5 s, then 55P03 answers 503 + Retry-After.
  await takeCompanyNumberLock(companyId, 'items_upsert', ITEM_CODE_SEED);

  const codes = [...new Set(rows.map((r) => r.code).filter((c): c is string => !!c))];
  const refs = rows.filter((r) => r.externalSystem && r.externalRef);
  const refSystems = refs.map((r) => r.externalSystem as string);
  const refValues = refs.map((r) => r.externalRef as string);

  const existing = (await sql`
    SELECT i.* FROM items i
    WHERE i.company_id = ${companyId}::UUID
      AND (i.code = ANY(${codes}::TEXT[]) OR i.id = ANY(${extraItemIds}::UUID[])
           OR (i.external_system, i.external_ref) IN (SELECT * FROM unnest(${refSystems}::TEXT[], ${refValues}::TEXT[])))
  `) as DbRow[];

  const byId = new Map<string, ExistingItem>();
  const byCode = new Map<string, ExistingItem>();
  const byRef = new Map<string, ExistingItem>();
  for (const r of existing) {
    const item = mapExisting(r);
    byId.set(item.id, item);
    byCode.set(item.code, item);
    if (item.externalSystem && item.externalRef) byRef.set(refKey(item.externalSystem, item.externalRef), item);
  }

  const categories = ((await sql`
    SELECT id, code, name, is_active FROM item_categories WHERE company_id = ${companyId}::UUID
  `) as DbRow[]).map((c) => ({ id: String(c.id), code: s(c.code), name: String(c.name), isActive: c.is_active !== false }));

  const accountIds = [...new Set(rows.flatMap((r) => [r.salesAccountId, r.purchasesAccountId]).filter((a): a is string => !!a))];
  const accounts = new Map<string, boolean>();
  if (accountIds.length > 0) {
    const found = (await sql`
      SELECT id, is_active FROM gl_accounts
      WHERE company_id = ${companyId}::UUID AND id = ANY(${accountIds}::UUID[])
    `) as DbRow[];
    for (const a of found) accounts.set(String(a.id), a.is_active !== false);
  }

  const matchedIds = [...byId.keys()];
  const itemsWithMovements = new Set<string>();
  if (matchedIds.length > 0) {
    const moved = (await sql`
      SELECT DISTINCT item_id FROM stock_movements
      WHERE company_id = ${companyId}::UUID AND item_id = ANY(${matchedIds}::UUID[])
    `) as DbRow[];
    for (const m of moved) itemsWithMovements.add(String(m.item_id));
  }
  return { byId, byCode, byRef, categories, accounts, itemsWithMovements };
}
