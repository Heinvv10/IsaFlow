/**
 * The item links of a customer-invoice draft edit's replacement lines (migration 1005): a line naming a NEW item is
 * checked (this company's, active) and, with no account of its own, defaults to the item's sales account; a line sent
 * without an item keeps an identical stored line's; null clears it. See items/itemEditLines. Reads only, before any write.
 */
import { ItemLineRefusal } from '../items/itemLineDefaults';
import { resolveEditLineItems } from '../items/itemEditLines';

type Row = Record<string, unknown>;

export async function resolveDraftEditItems<T extends { description: string; quantity: number; unitPrice: number; itemId?: string | null; glAccountId?: string | null }>(
  companyId: string, items: readonly T[], storedRows: readonly Row[],
): Promise<{ items: T[] } | { message: string }> {
  try {
    return {
      items: await resolveEditLineItems(companyId, 'sales', items, storedRows.map((r) => ({
        itemId: r.item_id == null ? null : String(r.item_id), description: String(r.description), quantity: Number(r.quantity), unitPrice: Number(r.unit_price),
      })), (i) => `items[${i}]`),
    };
  } catch (err) {
    if (err instanceof ItemLineRefusal) return { message: err.message };
    throw err;
  }
}
