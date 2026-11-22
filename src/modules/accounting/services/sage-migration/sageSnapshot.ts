/**
 * What the company holds that a migration run touches, read through the request transaction's own connection (RLS applies,
 * and every query names the company). The runner reads it before the run (the plan refuses rows the database would refuse)
 * and after a live run; the difference is what the run did.
 */
import { sql } from '@/lib/neon';

/** An item of the company, deleted ones included (the item tool matches them and refuses them). Codes are unique case-sensitively. */
export interface ExistingItem {
  id: string;
  code: string;
  system: string | null;
  ref: string | null;
  deleted: boolean;
}

export interface Snapshot {
  /** external_ref of every live item the Sage migration owns. */
  itemRefs: Set<string>;
  /** external_ref -> total in cents of every Sage purchase order. */
  poTotals: Map<string, number>;
  stockMovements: number;
  items: ExistingItem[];
  /** supplier uuid -> the Sage reference it carries (live suppliers; none carrying one are absent). */
  supplierSageRefs: Map<string, string>;
  /** po_number -> the external reference the PO carries (null: none). Numbers are unique per company, case-sensitively. */
  poNumbers: Map<string, { system: string | null; ref: string | null }>;
}

export async function readSnapshot(companyId: string): Promise<Snapshot> {
  const items = (await sql`
    SELECT id::TEXT AS id, code, external_system, external_ref, (deleted_at IS NOT NULL) AS deleted FROM items
    WHERE company_id = ${companyId}::UUID
  `) as Array<{ id: string; code: string; external_system: string | null; external_ref: string | null; deleted: boolean }>;
  const pos = (await sql`
    SELECT po_number, lower(external_system) AS external_system, external_ref, round(total * 100)::BIGINT AS cents FROM purchase_orders
    WHERE company_id = ${companyId}::UUID
  `) as Array<{ po_number: string; external_system: string | null; external_ref: string | null; cents: string | number }>;
  const suppliers = (await sql`
    SELECT id::TEXT AS id, external_ref FROM suppliers
    WHERE company_id = ${companyId}::UUID AND lower(external_system) = 'sage' AND external_ref IS NOT NULL AND deleted_at IS NULL
  `) as Array<{ id: string; external_ref: string }>;
  const stock = (await sql`SELECT count(*)::INT AS n FROM stock_movements WHERE company_id = ${companyId}::UUID`) as Array<{ n: number }>;
  const existing = items.map((r): ExistingItem => ({
    id: String(r.id), code: r.code, system: r.external_system ? r.external_system.toLowerCase() : null,
    ref: r.external_ref === null ? null : String(r.external_ref), deleted: r.deleted === true,
  }));
  return {
    itemRefs: new Set(existing.filter((i) => i.system === 'sage' && i.ref !== null && !i.deleted).map((i) => i.ref!)),
    poTotals: new Map(pos.filter((r) => r.external_system === 'sage' && r.external_ref !== null).map((r) => [String(r.external_ref), Number(r.cents)])),
    stockMovements: Number(stock[0]?.n ?? 0),
    items: existing,
    supplierSageRefs: new Map(suppliers.map((r) => [String(r.id), String(r.external_ref)])),
    poNumbers: new Map(pos.map((r) => [String(r.po_number), { system: r.external_system, ref: r.external_ref === null ? null : String(r.external_ref) }])),
  };
}
