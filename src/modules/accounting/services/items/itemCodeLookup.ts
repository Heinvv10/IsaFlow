/**
 * Items by their catalogue CODE (`items_company_id_code_key`: unique per company), for the callers that name a line's item by
 * code rather than id (MCP update_purchase_order `lines[].item_code`). Company-scoped, deleted items excluded; an inactive item is
 * found (the line defaults refuse it, `itemLineDefaults.applyItemLineDefaults`). Reads only.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export async function itemIdsByCode(companyId: string, codes: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const distinct = [...new Set(codes)];
  if (distinct.length === 0) return out;
  const rows = (await sql`
    SELECT id::TEXT AS id, code FROM items
     WHERE company_id = ${companyId}::UUID AND code = ANY(${distinct}::TEXT[]) AND deleted_at IS NULL
  `) as DbRow[];
  for (const r of rows) out.set(String(r.code), String(r.id).toLowerCase());
  return out;
}
