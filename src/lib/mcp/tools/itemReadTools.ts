/**
 * MCP read tools for the item master (Phase A): `list_items`, `get_item`, `list_item_categories`.
 *
 * Scope `read:items`. `list_items` is keyset-paged (contracts/cursor.ts) on (code, id), filterable by the fields a
 * migration needs (type, category, active, tracked, external reference) and returns the canonical item shape:
 * `purchase_price` is `items.cost_price`, `sales_price` is `items.selling_price_excl`.
 */
import type { McpTool } from '../types';
import { listCatalogItems, getCatalogItem } from '@/modules/accounting/services/items/itemCatalogRead';
import { listItemCategories } from '@/modules/accounting/services/items/itemCategoryService';
import { ITEM_TYPES, type CatalogItem } from '@/modules/accounting/services/items/itemCatalogTypes';
import { buildEnvelope, decodeCursor, encodeCursor, isDetailLevel } from '../contracts';
import type { DetailLevel } from '../contracts';
import { fmtDate } from '@/lib/fmtDate';
import { NOT_FOUND, clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

export const ITEMS_DEFAULT_LIMIT = 50;
/** An item row with every field at its longest is about 1.3 KB of JSON: 50 stay under a client's ~90 KB result limit (itemReadTools.test.ts). */
export const ITEMS_MAX_LIMIT = 50;
/** A description is free text on the UI's items (no length limit there); the list cuts it so one long one cannot make the page unreadable. get_item has it whole. */
const LIST_DESCRIPTION_CHARS = 255;

export function itemOut(i: CatalogItem, whole = false): Record<string, unknown> {
  return {
    id: i.id,
    code: i.code,
    description: whole ? i.description : i.description.slice(0, LIST_DESCRIPTION_CHARS),
    item_type: i.itemType,
    unit: i.unit,
    category_id: i.categoryId,
    category_code: i.categoryCode,
    category_name: i.categoryName,
    purchase_price: i.purchasePrice,
    sales_price: i.salesPrice,
    vat_on_sales: i.vatOnSales,
    vat_on_purchases: i.vatOnPurchases,
    sales_account_id: i.salesAccountId,
    purchases_account_id: i.purchasesAccountId,
    inventory_tracked: i.inventoryTracked,
    is_active: i.isActive,
    external_system: i.externalSystem,
    external_ref: i.externalRef,
    external_document_number: i.externalDocumentNumber,
    ...(whole ? { notes: i.notes, updated_at: i.updatedAt } : {}),
  };
}

/** undefined = absent, null = present but not a boolean. */
function boolArg(args: Record<string, unknown>, key: string): boolean | undefined | null {
  const v = args[key];
  if (v === undefined) return undefined;
  return typeof v === 'boolean' ? v : null;
}

export const listItemsTool: McpTool = {
  name: 'list_items',
  description:
    'List the item master: the products and services that go on a purchase order, bill, invoice or quote, with code, description, type, unit, '
    + 'purchase_price (cost, excl. VAT), sales_price (excl. VAT), VAT types, default sales / purchases GL accounts, category, inventory_tracked, is_active and the external '
    + '(source system) reference. Sorted by code, paged with next_cursor (at most ' + ITEMS_MAX_LIMIT + ' per page; pass it back as cursor until it is null). '
    + 'Filters: q (code or description contains), type, category_id, is_active, inventory_tracked, external_system + external_ref. '
    + 'rowsTotal is the count of the WHOLE filter, not the page. Soft-deleted items never appear; inactive ones do unless is_active is given. '
    + 'This is the `items` catalogue; the older `products` table is retired and holds no new rows. Use stock_valuation for stock on hand.',
  scope: 'read:items',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'Matches item code or description.' },
      type: { type: 'string', enum: [...ITEM_TYPES] },
      category_id: { type: 'string', description: 'Item category UUID (list_item_categories).' },
      is_active: { type: 'boolean' },
      inventory_tracked: { type: 'boolean' },
      external_system: { type: 'string', maxLength: 32 },
      external_ref: { type: 'string', maxLength: 128, description: 'With external_system.' },
      limit: { type: 'integer', minimum: 1, maximum: ITEMS_MAX_LIMIT },
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'], description: 'summary = totals only.' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { uuid: ['category_id'] });
    if (guard) return guard;
    const type = strArg(args, 'type');
    if (type !== undefined && !(ITEM_TYPES as readonly string[]).includes(type)) return toolError(`type must be one of: ${ITEM_TYPES.join(', ')}`);
    const isActive = boolArg(args, 'is_active');
    const tracked = boolArg(args, 'inventory_tracked');
    if (isActive === null || tracked === null) return toolError('is_active and inventory_tracked must be true or false');
    const system = strArg(args, 'external_system')?.toLowerCase();
    const ref = strArg(args, 'external_ref');
    if ((ref !== undefined) !== (system !== undefined)) return toolError('external_system and external_ref go together');
    const rawCursor = strArg(args, 'cursor');
    const cursor = rawCursor === undefined ? null : decodeCursor(rawCursor, 2);
    if (rawCursor !== undefined && cursor === null) return toolError('invalid cursor');
    const detailArg = strArg(args, 'detail');
    const detail: DetailLevel = isDetailLevel(detailArg) ? detailArg : 'standard';
    const limit = detail === 'summary' ? 1 : clampLimit(args, ITEMS_DEFAULT_LIMIT, ITEMS_MAX_LIMIT);

    const page = await listCatalogItems(
      ctx.companyId,
      { q: strArg(args, 'q'), type, categoryId: strArg(args, 'category_id'), isActive, inventoryTracked: tracked, externalSystem: system, externalRef: ref },
      cursor ? { code: cursor.parts[0]!, id: cursor.parts[1]! } : null,
      limit,
    );
    return ok(buildEnvelope({
      rows: detail === 'summary' ? [] : page.items.map((i) => itemOut(i)),
      rowsTotal: page.total,
      detail,
      as_at: fmtDate(new Date()),
      // A catalogue, not a ledger: there is nothing honest to pin it to, and now() would prove nothing.
      posted_through: null,
      next_cursor: detail === 'summary' || !page.next ? null : encodeCursor({ parts: [page.next.code, page.next.id] }),
      // universeTotal omitted deliberately: these rows ARE the population; there is no excluded set to account for.
    }));
  },
};

export const getItemTool: McpTool = {
  name: 'get_item',
  description:
    'One catalogue item, by item_id, by code, or by external_system + external_ref (give exactly one way). Returns every field list_items does plus notes and updated_at. '
    + 'A miss, and an item of another company, both answer "Not found".',
  scope: 'read:items',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      item_id: { type: 'string' },
      code: { type: 'string', maxLength: 50 },
      external_system: { type: 'string', maxLength: 32 },
      external_ref: { type: 'string', maxLength: 128 },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { uuid: ['item_id'] });
    if (guard) return guard;
    const id = strArg(args, 'item_id');
    const code = strArg(args, 'code');
    const system = strArg(args, 'external_system')?.toLowerCase();
    const ref = strArg(args, 'external_ref');
    if ((ref !== undefined) !== (system !== undefined)) return toolError('external_system and external_ref go together');
    const ways = [id, code, ref].filter((x) => x !== undefined).length;
    if (ways !== 1) return toolError('give exactly one of item_id, code, or external_system + external_ref');
    const item = await getCatalogItem(ctx.companyId, { id, code, externalSystem: system, externalRef: ref });
    return item ? ok({ item: itemOut(item, true) }) : toolError(NOT_FOUND);
  },
};

export const listItemCategoriesTool: McpTool = {
  name: 'list_item_categories',
  description:
    'The item categories: id, code, name, description, is_active, external reference and how many (non-deleted) items each holds. Sorted by name. '
    + 'Filters: q (name or code contains), is_active. Inactive categories are included unless is_active is given.',
  scope: 'read:items',
  write: false,
  inputSchema: {
    type: 'object',
    properties: { q: { type: 'string' }, is_active: { type: 'boolean' } },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const isActive = boolArg(args, 'is_active');
    if (isActive === null) return toolError('is_active must be true or false');
    const all = await listItemCategories(ctx.companyId, { includeInactive: true, q: strArg(args, 'q') });
    const categories = all.filter((c) => isActive === undefined || c.isActive === isActive);
    return ok({
      categories: categories.map((c) => ({
        id: c.id, code: c.code, name: c.name, description: c.description, is_active: c.isActive,
        external_system: c.externalSystem, external_ref: c.externalRef, item_count: c.itemCount,
      })),
      total: categories.length,
    });
  },
};
