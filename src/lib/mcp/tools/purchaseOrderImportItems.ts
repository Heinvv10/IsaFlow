/**
 * bulk_create_purchase_orders: the catalogue item each line links to (design docs/design/mcp-po-line-items.md). Reads only,
 * company-scoped, run in the tool's prepare step on the dry run too. The import LINKS the item and derives nothing from it (a
 * Sage line's own account, rate and amounts are stored as sent), so this returns ids, not defaults.
 *
 * Wording is `update_purchase_order`'s (itemLineDefaults): an id that is unknown, deleted or ANOTHER company's gets one and the same
 * refusal (no cross-tenant disclosure), as does a code; an inactive item is refused. The first refusal names the PO and the line.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { itemIdsByCode } from '@/modules/accounting/services/items/itemCodeLookup';
import type { ParsedPo } from './purchaseOrderImportArgs';

/** The linked item id of each line, keyed `${po index}:${line index}`; a line naming no item has no entry. Or the first refusal. */
export async function resolveLineItems(companyId: string, batch: readonly ParsedPo[]): Promise<Map<string, string> | string> {
  const lines = batch.flatMap((p) => p.lines.map((l, i) => ({ p, l, i, at: `purchase_orders[${p.index}].lines[${i}]` })));
  const byCode = await itemIdsByCode(companyId, lines.flatMap(({ l }) => (l.itemCode ? [l.itemCode] : [])));
  const named = new Map<string, string>();
  for (const { p, l, i } of lines) {
    const id = l.itemCode ? byCode.get(l.itemCode) : l.itemId;
    if (id) named.set(`${p.index}:${i}`, id);
  }
  const ids = [...new Set(named.values())];
  const rows = ids.length === 0 ? [] : (await sql`
    SELECT id::TEXT AS id, is_active FROM items
     WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[]) AND deleted_at IS NULL
  `) as DbRow[];
  const active = new Map(rows.map((r) => [String(r.id).toLowerCase(), r.is_active !== false]));
  // One pass in line order, so the refusal names the first offending line.
  for (const { p, l, i, at } of lines) {
    if (l.itemCode && !named.has(`${p.index}:${i}`)) return `${at}.item_code: no item with the code "${l.itemCode}" in this company`;
    const id = named.get(`${p.index}:${i}`);
    if (!id) continue;
    const isActive = active.get(id);
    if (isActive === undefined) return `${at}.item_id is not an item of your company`;
    if (!isActive) return `${at}.item_id is an inactive item`;
  }
  return named;
}
