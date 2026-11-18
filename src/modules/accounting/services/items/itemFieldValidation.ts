/**
 * Field validation for an item row, shared by `bulk_upsert_items` and `update_item`. PURE: no database, so every
 * refusal here happens before the first read, let alone the first write.
 *
 * An absent field is absent (kept on an existing item, defaulted on a new one). The tools cannot clear a field: a call
 * that forgot to mention `purchases_account_id` must not wipe it. A field present with a value that cannot be stored is
 * refused with a code the agent can branch on; an unknown key is refused too, because a typo such as `sales_price_excl`
 * would otherwise be ignored and the row reported as done.
 */
import { UUID_RE } from '@/lib/validation';
import { hasWholeCents } from '@/lib/money/wholeCents';
import {
  ITEM_TYPES, ITEM_VAT_TYPES, MAX_CODE_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_NOTES_LENGTH, MAX_UNIT_LENGTH,
} from './itemCatalogTypes';

export interface ItemFields {
  code?: string;
  description?: string;
  itemType?: string;
  unit?: string;
  categoryId?: string;
  categoryCode?: string;
  categoryName?: string;
  purchasePrice?: number;
  salesPrice?: number;
  vatOnSales?: string;
  vatOnPurchases?: string;
  salesAccountId?: string;
  purchasesAccountId?: string;
  inventoryTracked?: boolean;
  isActive?: boolean;
  notes?: string;
  externalSystem?: string;
  externalRef?: string;
  externalDocumentNumber?: string;
}

export type FieldCheck = { ok: true; fields: ItemFields } | { ok: false; code: string; reason: string };

/** The wire names a row may carry. `idempotency_key` / `dry_run` / `company_id` live on the call, never on a row. */
export const ITEM_ROW_KEYS = [
  'code', 'description', 'item_type', 'unit', 'category_id', 'category_code', 'category_name', 'purchase_price',
  'sales_price', 'vat_on_sales', 'vat_on_purchases', 'sales_account_id', 'purchases_account_id', 'inventory_tracked',
  'is_active', 'notes', 'external_system', 'external_ref', 'external_document_number',
] as const;

const MAX_EXTERNAL_REF = 128;
const MAX_EXTERNAL_DOC = 64;
const MAX_EXTERNAL_SYSTEM = 32;
const MAX_CATEGORY_TEXT = 255;
const PRICE_TEXT = /^\d{1,13}(\.\d{1,2})?$/;

const bad = (code: string, reason: string): FieldCheck => ({ ok: false, code, reason });

/** Money arrives as a number or a decimal string; either must be exact whole cents and not negative. */
function price(raw: unknown, key: string): number | FieldCheck {
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && PRICE_TEXT.test(raw.trim())) n = Number(raw.trim());
  else return bad('invalid_field', `${key} must be a number or a decimal string with at most 2 decimals`);
  if (!hasWholeCents(n)) return bad('invalid_field', `${key} must be a finite amount in whole cents`);
  if (n < 0) return bad('invalid_field', `${key} must not be negative`);
  return n;
}

function text(raw: unknown, key: string, max: number): string | FieldCheck {
  if (typeof raw !== 'string') return bad('invalid_field', `${key} must be a string`);
  const t = raw.trim();
  if (!t) return bad('invalid_field', `${key} must not be empty`);
  if (t.length > max) return bad('invalid_field', `${key} is longer than ${max} characters`);
  return t;
}

export function validateItemFields(row: Record<string, unknown>): FieldCheck {
  for (const key of Object.keys(row)) {
    if (!(ITEM_ROW_KEYS as readonly string[]).includes(key)) return bad('unknown_field', `${key} is not an item field`);
  }
  const f: ItemFields = {};
  const set = (key: keyof ItemFields, v: unknown): void => {
    (f as Record<string, unknown>)[key] = v;
  };
  const isCheck = (v: unknown): v is FieldCheck => typeof v === 'object' && v !== null;
  const textFields: Array<[string, keyof ItemFields, number]> = [
    ['code', 'code', MAX_CODE_LENGTH], ['description', 'description', MAX_DESCRIPTION_LENGTH],
    ['unit', 'unit', MAX_UNIT_LENGTH], ['notes', 'notes', MAX_NOTES_LENGTH],
    ['category_code', 'categoryCode', MAX_CATEGORY_TEXT], ['category_name', 'categoryName', MAX_CATEGORY_TEXT],
    ['external_ref', 'externalRef', MAX_EXTERNAL_REF], ['external_document_number', 'externalDocumentNumber', MAX_EXTERNAL_DOC],
  ];
  for (const [wire, key, max] of textFields) {
    if (row[wire] === undefined) continue;
    const v = text(row[wire], wire, max);
    if (isCheck(v)) return v;
    set(key, v);
  }
  if (row.external_system !== undefined) {
    const v = text(row.external_system, 'external_system', MAX_EXTERNAL_SYSTEM);
    if (isCheck(v)) return v;
    f.externalSystem = v.toLowerCase();
  }
  if (f.externalRef && !f.externalSystem) return bad('invalid_field', 'external_system is required with external_ref (e.g. "sage")');

  const enums: Array<[string, keyof ItemFields, readonly string[]]> = [
    ['item_type', 'itemType', ITEM_TYPES], ['vat_on_sales', 'vatOnSales', ITEM_VAT_TYPES],
    ['vat_on_purchases', 'vatOnPurchases', ITEM_VAT_TYPES],
  ];
  for (const [wire, key, allowed] of enums) {
    if (row[wire] === undefined) continue;
    const v = typeof row[wire] === 'string' ? (row[wire] as string).trim() : '';
    if (!allowed.includes(v)) return bad('invalid_field', `${wire} must be one of: ${allowed.join(', ')}`);
    set(key, v);
  }
  for (const [wire, key] of [['purchase_price', 'purchasePrice'], ['sales_price', 'salesPrice']] as const) {
    if (row[wire] === undefined) continue;
    const v = price(row[wire], wire);
    if (isCheck(v)) return v;
    set(key, v);
  }
  for (const [wire, key] of [
    ['category_id', 'categoryId'], ['sales_account_id', 'salesAccountId'], ['purchases_account_id', 'purchasesAccountId'],
  ] as const) {
    if (row[wire] === undefined) continue;
    if (typeof row[wire] !== 'string' || !UUID_RE.test(row[wire] as string)) return bad('invalid_field', `invalid ${wire}`);
    set(key, row[wire]);
  }
  for (const [wire, key] of [['inventory_tracked', 'inventoryTracked'], ['is_active', 'isActive']] as const) {
    if (row[wire] === undefined) continue;
    if (typeof row[wire] !== 'boolean') return bad('invalid_field', `${wire} must be true or false`);
    set(key, row[wire]);
  }
  const catParts = [f.categoryId, f.categoryCode, f.categoryName].filter((x) => x !== undefined).length;
  if (catParts > 1) return bad('invalid_field', 'name the category with one of category_id, category_code or category_name');
  return { ok: true, fields: f };
}
