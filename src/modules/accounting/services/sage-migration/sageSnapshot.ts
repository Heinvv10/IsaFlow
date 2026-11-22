/**
 * What the company holds that a migration run touches, read through the request transaction's own connection (RLS applies,
 * and every query names the company). The runner reads it before and after a live run; the difference is what the run did.
 */
import { sql } from '@/lib/neon';

export interface Snapshot {
  /** external_ref of every live item the Sage migration owns. */
  itemRefs: Set<string>;
  /** external_ref -> total in cents of every Sage purchase order. */
  poTotals: Map<string, number>;
  stockMovements: number;
}

export async function readSnapshot(companyId: string): Promise<Snapshot> {
  const items = (await sql`
    SELECT external_ref FROM items
    WHERE company_id = ${companyId}::UUID AND lower(external_system) = 'sage' AND deleted_at IS NULL
  `) as Array<{ external_ref: string }>;
  const pos = (await sql`
    SELECT external_ref, round(total * 100)::BIGINT AS cents FROM purchase_orders
    WHERE company_id = ${companyId}::UUID AND lower(external_system) = 'sage'
  `) as Array<{ external_ref: string; cents: string | number }>;
  const stock = (await sql`SELECT count(*)::INT AS n FROM stock_movements WHERE company_id = ${companyId}::UUID`) as Array<{ n: number }>;
  return {
    itemRefs: new Set(items.map((r) => String(r.external_ref))),
    poTotals: new Map(pos.map((r) => [String(r.external_ref), Number(r.cents)])),
    stockMovements: Number(stock[0]?.n ?? 0),
  };
}
