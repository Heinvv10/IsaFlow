/**
 * Argument parsing and reply shapes shared by the item tools (Phase A, docs/design/items-inventory-po-mcp.md).
 *
 * `ITEM_FIELD_PROPERTIES` is the one description of an item's writable fields: a `bulk_upsert_items` row and
 * `update_item` take the same names, and the same validator (`itemFieldValidation`) answers both with the same codes.
 * Nothing here touches the database.
 */
import { MAX_UPSERT_ROWS, type ItemRefusal } from '@/modules/accounting/services/items/itemCatalogTypes';
import { validateItemFields, type FieldCheck } from '@/modules/accounting/services/items/itemFieldValidation';
import type { PlanInputRow } from '@/modules/accounting/services/items/itemUpsertPlan';
import type { McpToolResult } from '../types';
import { toolError } from './toolHelpers';

export const ITEM_FIELD_PROPERTIES = {
  description: { type: 'string', maxLength: 255 },
  item_type: { type: 'string', enum: ['physical', 'service'], description: 'Default physical on create. A service is never stock.' },
  unit: { type: 'string', maxLength: 50, description: 'Unit of measure; default "each" on create.' },
  category_id: { type: 'string', description: 'Item category UUID. Name the category with ONE of category_id, category_code, category_name. An unknown category is refused (never created implicitly: use upsert_item_category).' },
  category_code: { type: 'string' },
  category_name: { type: 'string', description: 'Case-insensitive exact name.' },
  purchase_price: { type: 'number', minimum: 0, description: 'Cost price excl. VAT, whole cents. A decimal string is accepted too.' },
  sales_price: { type: 'number', minimum: 0, description: 'Selling price excl. VAT, whole cents. A decimal string is accepted too.' },
  vat_on_sales: { type: 'string', enum: ['standard', 'zero', 'exempt'] },
  vat_on_purchases: { type: 'string', enum: ['standard', 'zero', 'exempt'] },
  sales_account_id: { type: 'string', description: 'Default GL account of a sales line naming this item (an active account of this company).' },
  purchases_account_id: { type: 'string', description: 'Default GL account of a purchase-order or bill line naming this item (an active account of this company).' },
  inventory_tracked: { type: 'boolean', description: 'Default false. A service cannot be tracked.' },
  is_active: { type: 'boolean' },
  notes: { type: 'string', maxLength: 2000 },
  external_system: { type: 'string', maxLength: 32, description: 'e.g. "sage". Required with external_ref.' },
  external_ref: { type: 'string', maxLength: 128, description: 'The source system\'s own id for the item.' },
  external_document_number: { type: 'string', maxLength: 64 },
} as const;

export const ITEM_ROW_SCHEMA = {
  type: 'object',
  properties: { code: { type: 'string', maxLength: 50 }, ...ITEM_FIELD_PROPERTIES },
  required: ['code'],
  additionalProperties: false,
} as const;

export interface ParsedItemRows {
  /** Rows that passed field validation, with their position in the array the agent sent. */
  rows: PlanInputRow[];
  refusals: ItemRefusal[];
}

/** Every row validated, every refusal kept: an agent fixes a 383-row payload in one pass, not one error at a time. */
export function parseItemRows(raw: unknown): ParsedItemRows | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'items must be a non-empty array of item rows';
  if (raw.length > MAX_UPSERT_ROWS) return `too many rows (${raw.length}); the maximum is ${MAX_UPSERT_ROWS} per call`;
  const rows: PlanInputRow[] = [];
  const refusals: ItemRefusal[] = [];
  raw.forEach((row, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      refusals.push({ index, code: 'invalid_row', reason: 'each row must be an object' });
      return;
    }
    const checked = validateItemFields(row as Record<string, unknown>);
    if (checked.ok) rows.push({ index, fields: checked.fields });
    else refusals.push({ index, code: checked.code, reason: checked.reason });
  });
  return { rows, refusals };
}

/** A batch refused as a whole: nothing was written, and every refused row is listed with its reason code. */
export function batchRefusal(refusals: ItemRefusal[], dryRun: boolean): McpToolResult {
  const sorted = [...refusals].sort((a, b) => a.index - b.index);
  return toolError(JSON.stringify({
    refused: true,
    dry_run: dryRun,
    written: false,
    message: `${sorted.length} row(s) refused; nothing was written. Fix them and send the whole batch again.`,
    refusals: sorted,
  }));
}

/** A single-row tool's refusal. */
export function rowRefusal(code: string, reason: string): McpToolResult {
  return toolError(`${code}: ${reason}`);
}

/** The fields of an `update_item` call: every item field of a row (`code` renames the item here), minus the call's own keys. */
export function itemFieldsFromArgs(args: Record<string, unknown>): FieldCheck {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (['item_id', 'idempotency_key', 'dry_run', 'company_id'].includes(key)) continue;
    row[key] = value;
  }
  return validateItemFields(row);
}
