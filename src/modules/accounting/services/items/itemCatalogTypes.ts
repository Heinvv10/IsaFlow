/**
 * The item master as the MCP item tools see it (Phase A, docs/design/items-inventory-po-mcp.md).
 *
 * One row shape for every reader and writer in the item catalogue group, and the vocabulary the validators share.
 * `items.cost_price` is the PURCHASE price and `items.selling_price_excl` the SALES price: the columns keep their
 * names (the UI and the pickers read them), the catalogue shape names them for what they are.
 */
import type { DbRow } from '@/lib/neon';

export const ITEM_TYPES = ['physical', 'service'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** The tax types the UI offers and `items.vat_on_*` hold. */
export const ITEM_VAT_TYPES = ['standard', 'zero', 'exempt'] as const;

export const MAX_UPSERT_ROWS = 500;
export const MAX_CODE_LENGTH = 50;
export const MAX_DESCRIPTION_LENGTH = 255;
export const MAX_UNIT_LENGTH = 50;
export const MAX_NOTES_LENGTH = 2000;

export interface CatalogItem {
  id: string;
  code: string;
  description: string;
  itemType: string;
  categoryId: string | null;
  categoryCode: string | null;
  categoryName: string | null;
  isActive: boolean;
  unit: string | null;
  purchasePrice: number;
  salesPrice: number;
  vatOnSales: string | null;
  vatOnPurchases: string | null;
  salesAccountId: string | null;
  purchasesAccountId: string | null;
  inventoryTracked: boolean;
  externalSystem: string | null;
  externalRef: string | null;
  externalDocumentNumber: string | null;
  notes: string | null;
  updatedAt: string | null;
}

export interface CatalogCategory {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  isActive: boolean;
  externalSystem: string | null;
  externalRef: string | null;
  itemCount: number;
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : str(v));

export function mapItemRow(r: DbRow): CatalogItem {
  return {
    id: String(r.id),
    code: String(r.code),
    description: String(r.description ?? ''),
    itemType: String(r.item_type ?? 'physical'),
    categoryId: str(r.category_id),
    categoryCode: str(r.category_code),
    categoryName: str(r.category_name),
    isActive: r.is_active !== false,
    unit: str(r.unit),
    purchasePrice: Number(r.cost_price) || 0,
    salesPrice: Number(r.selling_price_excl) || 0,
    vatOnSales: str(r.vat_on_sales),
    vatOnPurchases: str(r.vat_on_purchases),
    salesAccountId: str(r.sales_account_id),
    purchasesAccountId: str(r.purchases_account_id),
    inventoryTracked: r.inventory_tracked === true,
    externalSystem: str(r.external_system),
    externalRef: str(r.external_ref),
    externalDocumentNumber: str(r.external_document_number),
    notes: str(r.notes),
    updatedAt: iso(r.updated_at),
  };
}

export function mapCategoryRow(r: DbRow): CatalogCategory {
  return {
    id: String(r.id),
    code: str(r.code),
    name: String(r.name),
    description: str(r.description),
    isActive: r.is_active !== false,
    externalSystem: str(r.external_system),
    externalRef: str(r.external_ref),
    itemCount: Number(r.item_count) || 0,
  };
}

/**
 * One refusal, tied to the row that caused it. `code` is machine-stable (an agent branches on it), `reason` is for a
 * person. `index` is the position in the array the AGENT sent.
 */
export interface ItemRefusal {
  index: number;
  code: string;
  reason: string;
}
