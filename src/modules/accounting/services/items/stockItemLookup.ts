import { sql } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';

/** Entries one opening-balance or pricing request may carry. */
export const MAX_STOCK_ITEM_BATCH = 500;

/**
 * The batch's item ids, lowercased, or why the batch is refused (a 400): an id
 * that is not a UUID string, the same item twice (the later entry would
 * silently win), or more than MAX_STOCK_ITEM_BATCH entries.
 */
export function stockItemBatchIds(itemIds: readonly unknown[]): { ids: string[] } | { error: string } {
  if (itemIds.length > MAX_STOCK_ITEM_BATCH) return { error: `At most ${MAX_STOCK_ITEM_BATCH} items per request` };
  const ids: string[] = [];
  for (const raw of itemIds) {
    if (typeof raw !== 'string' || !UUID_RE.test(raw.trim())) return { error: 'Each itemId must be a stock item id' };
    const id = raw.trim().toLowerCase();
    if (ids.includes(id)) return { error: `Stock item ${id} appears more than once` };
    ids.push(id);
  }
  return { ids };
}

/** A finite, non-negative number from a request field, or null. */
export function nonNegativeAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The ids (from stockItemBatchIds) that are not stock items of `companyId`:
 * unknown, or another company's.
 *
 * The batch writers call this BEFORE their first UPDATE: withAuth commits a
 * 4xx, so a refusal raised mid-batch would leave the earlier entries written.
 * The lookup and the UPDATEs are separate statements; that gap is safe only
 * because no route deletes a stock item.
 */
export async function missingStockItemIds(companyId: string, ids: readonly string[]): Promise<string[]> {
  const found = (await sql`
    SELECT id::TEXT AS id FROM stock_items
    WHERE company_id = ${companyId}::UUID AND id = ANY(${[...ids]}::UUID[])
  `) as { id: string }[];
  const known = new Set(found.map((r) => r.id));
  return ids.filter((id) => !known.has(id));
}

/** The 404 message's id list: the first ten, then a count. */
export function describeMissing(ids: readonly string[]): string {
  return ids.length <= 10 ? ids.join(', ') : `${ids.slice(0, 10).join(', ')} and ${ids.length - 10} more`;
}
