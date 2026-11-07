import { sql } from '@/lib/neon';

/**
 * The ids in `ids` that are not stock items of `companyId` (unknown, or
 * another company's), in request order, without duplicates.
 *
 * The batch writers (item-opening-balances, item-pricing) call this BEFORE
 * their first UPDATE: withAuth commits a 4xx, so a refusal raised mid-batch
 * would leave the earlier entries written.
 */
export async function missingStockItemIds(companyId: string, ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  const found = (await sql`
    SELECT id::TEXT AS id FROM stock_items
    WHERE company_id = ${companyId}::UUID AND id::TEXT = ANY(${unique}::TEXT[])
  `) as { id: string }[];
  const known = new Set(found.map((r) => r.id));
  return unique.filter((id) => !known.has(id));
}
