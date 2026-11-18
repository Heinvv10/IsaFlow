/**
 * MCP write tools for the item master (Phase A): `bulk_upsert_items`, `update_item`, `deactivate_item`,
 * `upsert_item_category`. Scope `write:items`; none posts to the ledger, so none is `requiresPost` and all are free.
 *
 * What every one of them does, the same way:
 *   - the company comes from the token (`ctx.companyId`); the registry refuses a `company_id` argument that disagrees;
 *   - `dry_run` runs the SAME plan the live call runs (itemUpsertPlan, a pure decision over what the company holds) and
 *     stops before the write: it cannot pass where the live call refuses. A dry run sets `wroteNothing`, so it does not
 *     consume the idempotency key and "preview, then apply, one key" works;
 *   - every refusal happens before the first write and is returned as a result, never thrown after a write;
 *   - the audit row is the registry's own (mcp_tool_calls).
 * The tools cannot clear a field: a field left out keeps its value, so a call that forgot `purchases_account_id` does not
 * wipe it.
 */
import type { McpTool, McpToolResult } from '../types';
import { applyItemPlan, deactivateCatalogItem, planItemBatch } from '@/modules/accounting/services/items/itemUpsertService';
import {
  applyCategoryPlan, planCategoryUpsert, validateCategoryInput,
} from '@/modules/accounting/services/items/itemCategoryService';
import { MAX_UPSERT_ROWS } from '@/modules/accounting/services/items/itemCatalogTypes';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';
import {
  ITEM_FIELD_PROPERTIES, ITEM_ROW_SCHEMA, batchRefusal, itemFieldsFromArgs, parseItemRows, rowRefusal,
} from './itemToolArgs';

const SCOPE = 'write:items';

/** A result that wrote nothing: a dry run, or a call that found everything already as asked. */
function wroteNothing(data: Record<string, unknown>): McpToolResult {
  const r = ok(data);
  r.wroteNothing = true;
  r.billable = false;
  return r;
}

export const bulkUpsertItemsTool: McpTool = {
  name: 'bulk_upsert_items',
  description:
    `Create or update up to ${MAX_UPSERT_ROWS} catalogue items in ONE call, ALL OR NOTHING: if any row is refused, nothing is written and every refusal is returned with its row index and a reason code. `
    + 'A row matches an existing item by (external_system, external_ref) first, then by code. A row whose reference and code belong to two DIFFERENT items is refused (ref_code_conflict); so is a code that already carries another reference, '
    + 'a code or reference repeated in the batch, a service marked inventory_tracked, an unknown or inactive category, and a GL account that is not an active account of this company. '
    + 'Each row comes back created, updated or unchanged (with the fields that changed): a re-run of identical input reports every row unchanged and writes nothing. '
    + 'A field a row leaves out keeps its stored value (a new item takes defaults: type physical, unit each, VAT standard, prices 0, inventory_tracked false), so no row can clear a field. '
    + 'Category by category_id, category_code or category_name (never created implicitly: use upsert_item_category first). This tool records no stock: quantities on hand are not imported here. '
    + 'Posts nothing to the ledger. Run with dry_run: true first: it returns the same outcomes and refusals and writes nothing.',
  scope: SCOPE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      items: { type: 'array', minItems: 1, maxItems: MAX_UPSERT_ROWS, items: ITEM_ROW_SCHEMA },
      dry_run: { type: 'boolean', description: 'Preview only: the same outcomes and refusals, nothing written, the idempotency_key not consumed.' },
      idempotency_key: { type: 'string' },
    },
    required: ['items', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const parsed = parseItemRows(args.items);
    if (typeof parsed === 'string') return toolError(parsed);
    const dryRun = args.dry_run === true;
    const plan = await planItemBatch(ctx.companyId, parsed.rows);
    const refusals = [...parsed.refusals, ...plan.refusals];
    if (refusals.length > 0) return batchRefusal(refusals, dryRun);

    const ids = dryRun ? new Map<number, string>() : await applyItemPlan(ctx.companyId, plan.planned);
    const rows = [...plan.planned].sort((a, b) => a.index - b.index).map((p) => ({
      index: p.index,
      outcome: p.outcome,
      id: ids.get(p.index) ?? p.itemId,
      code: p.code,
      ...(p.outcome === 'unchanged' ? {} : { changed: p.changed }),
    }));
    const count = (o: string) => plan.planned.filter((p) => p.outcome === o).length;
    const body = {
      dry_run: dryRun,
      written: !dryRun && (count('created') > 0 || count('updated') > 0),
      counts: { created: count('created'), updated: count('updated'), unchanged: count('unchanged'), total: rows.length },
      rows,
    };
    return dryRun ? wroteNothing(body) : ok(body);
  },
};

export const updateItemTool: McpTool = {
  name: 'update_item',
  description:
    'Change one catalogue item (item_id from list_items / get_item). Send only the fields that change; anything left out KEEPS its value, so this tool cannot clear a field. '
    + 'code renames the item (document lines follow it by id). Same fields and the same refusals as a bulk_upsert_items row, plus: an item with stock movements cannot become a service (has_stock_movements). '
    + 'A change that changes nothing succeeds as unchanged. Posts nothing to the ledger. dry_run previews the same result without writing.',
  scope: SCOPE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      item_id: { type: 'string' },
      code: { type: 'string', maxLength: 50, description: 'The new code.' },
      ...ITEM_FIELD_PROPERTIES,
      dry_run: { type: 'boolean' },
      idempotency_key: { type: 'string' },
    },
    required: ['item_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { uuid: ['item_id'] });
    if (bad) return bad;
    const itemId = strArg(args, 'item_id');
    if (!itemId) return toolError('item_id is required');
    const checked = itemFieldsFromArgs(args);
    if (!checked.ok) return rowRefusal(checked.code, checked.reason);
    if (Object.keys(checked.fields).length === 0) return toolError('send at least one field to change');

    const dryRun = args.dry_run === true;
    const plan = await planItemBatch(ctx.companyId, [{ index: 0, fields: checked.fields, targetId: itemId }]);
    const refusal = plan.refusals[0];
    if (refusal) return refusal.code === 'item_not_found' ? toolError(NOT_FOUND) : rowRefusal(refusal.code, refusal.reason);
    const planned = plan.planned[0]!;
    const body = { dry_run: dryRun, id: planned.itemId, code: planned.code, outcome: planned.outcome, changed: planned.changed };
    if (planned.outcome === 'unchanged' || dryRun) return wroteNothing(body);
    await applyItemPlan(ctx.companyId, plan.planned);
    return ok(body);
  },
};

export const deactivateItemTool: McpTool = {
  name: 'deactivate_item',
  description:
    'Retire a catalogue item: is_active = false. The item stays (documents that name it keep their link, history is untouched) but a new purchase-order, bill, invoice or quote line naming it is refused. '
    + 'Idempotent: an item already inactive comes back changed: false. Cannot delete an item; reactivate with update_item is_active true. dry_run previews. Posts nothing to the ledger.',
  scope: SCOPE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: { item_id: { type: 'string' }, dry_run: { type: 'boolean' }, idempotency_key: { type: 'string' } },
    required: ['item_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { uuid: ['item_id'] });
    if (bad) return bad;
    const itemId = strArg(args, 'item_id');
    if (!itemId) return toolError('item_id is required');
    const dryRun = args.dry_run === true;
    const result = await deactivateCatalogItem(ctx.companyId, itemId, { dryRun });
    if (!result) return toolError(NOT_FOUND);
    const body = { dry_run: dryRun, id: result.id, code: result.code, is_active: dryRun ? result.wasActive : false, changed: result.wasActive };
    return dryRun || !result.wasActive ? wroteNothing(body) : ok(body);
  },
};

export const upsertItemCategoryTool: McpTool = {
  name: 'upsert_item_category',
  description:
    'Create or update one item category. Matches by (external_system, external_ref) first, then code, then (when neither is given) the name, case-insensitively. '
    + 'A name, code or reference that belongs to a DIFFERENT category is refused (name_in_use, code_in_use_by_other_ref, ref_code_conflict). Returns created, updated or unchanged. '
    + 'Fields left out keep their value (a new category is active). Cannot delete a category. dry_run previews. Posts nothing to the ledger.',
  scope: SCOPE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: 255 },
      code: { type: 'string', maxLength: 50, description: 'Unique per company when present.' },
      description: { type: 'string', maxLength: 1000 },
      is_active: { type: 'boolean' },
      external_system: { type: 'string', maxLength: 32 },
      external_ref: { type: 'string', maxLength: 128 },
      dry_run: { type: 'boolean' },
      idempotency_key: { type: 'string' },
    },
    required: ['name', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const raw: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (!['idempotency_key', 'dry_run', 'company_id'].includes(k)) raw[k] = v;
    const checked = validateCategoryInput(raw);
    if (!checked.ok) return rowRefusal('invalid_field', checked.reason);
    const dryRun = args.dry_run === true;
    const plan = await planCategoryUpsert(ctx.companyId, checked.input);
    if ('refusal' in plan) return rowRefusal(plan.refusal.code, plan.refusal.reason);
    const body = { dry_run: dryRun, id: plan.id, name: checked.input.name, outcome: plan.outcome, changed: plan.changed };
    if (dryRun || plan.outcome === 'unchanged') return wroteNothing(body);
    const id = await applyCategoryPlan(ctx.companyId, plan);
    return ok({ ...body, id });
  },
};
