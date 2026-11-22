/**
 * What the company holds that a migration run touches, read through the request transaction's own connection (RLS applies,
 * and every query names the company). The runner reads it before the run (the plan refuses rows the database would refuse)
 * and after a live run; the difference is what the run did.
 */
import { sql } from '@/lib/neon';
import type { PoContent } from './sagePoContent';
import { readCheckPolicy } from '@/modules/accounting/services/budgets/budgetCheck';

/** An item of the company, deleted ones included (the item tool matches them and refuses them). Codes are unique case-sensitively. */
export interface ExistingItem {
  id: string;
  code: string;
  system: string | null;
  ref: string | null;
  deleted: boolean;
  itemType: string;
  inventoryTracked: boolean;
  isActive: boolean;
  /**
   * A hash of every column the item tool compares and of updated_at: it changes whenever the row is written, even back to an earlier state.
   * Timestamps go in as epoch seconds, so the hash does not depend on the session's TimeZone or DateStyle.
   */
  stateHash: string;
  /** The item has stock_movements rows: its type and tracking are no longer free to change. */
  hasMovements: boolean;
}

/** An item category of the company. The category tool matches by reference, code, then name (case-insensitively). */
export interface ExistingCategory {
  id: string;
  name: string;
  system: string | null;
  ref: string | null;
  isActive: boolean;
  /** Like an item's: every column the category tool compares plus updated_at (epoch seconds). */
  stateHash: string;
}

export interface Snapshot {
  /** external_ref of every live item the Sage migration owns. */
  itemRefs: Set<string>;
  /** external_ref -> total in cents of every Sage purchase order. */
  poTotals: Map<string, number>;
  /** external_ref -> a hash of the state of that Sage PO: every field the PO tool compares on a replay, its line items, and updated_at (epoch seconds). */
  poStates: Map<string, string>;
  /** external_ref -> how many lines of that Sage PO carry an item_id. */
  poLinkedLines: Map<string, number>;
  /** external_ref -> the supplier, delivery date, reference and lines of that Sage PO (compared by sagePoContent on a re-run). */
  poContent: Map<string, PoContent>;
  stockMovements: number;
  items: ExistingItem[];
  categories: ExistingCategory[];
  /** The company's budget check policy (off | warn | block; warn when none is set), as the PO import reads it. */
  budgetPolicy: string;
  /** Suppliers of the company that are inactive (is_active false): a PO to one is refused. */
  inactiveSuppliers: Set<string>;
  /** supplier uuid -> the Sage reference it carries (live suppliers; none carrying one are absent). */
  supplierSageRefs: Map<string, string>;
  /** po_number -> the external reference the PO carries (null: none). Numbers are unique per company, case-sensitively. */
  poNumbers: Map<string, { system: string | null; ref: string | null }>;
}

export async function readSnapshot(companyId: string): Promise<Snapshot> {
  const items = (await sql`
    SELECT i.id::TEXT AS id, i.code, i.external_system, i.external_ref, (i.deleted_at IS NOT NULL) AS deleted, i.item_type, i.inventory_tracked, i.is_active,
           md5(row(i.code, i.description, i.item_type, i.unit, i.category_id, i.cost_price, i.selling_price_excl, i.vat_on_sales, i.vat_on_purchases,
                   i.sales_account_id, i.purchases_account_id, i.inventory_tracked, i.is_active, i.notes, i.external_system, i.external_ref,
                   i.external_document_number, extract(epoch FROM i.deleted_at), extract(epoch FROM i.updated_at))::TEXT) AS state_hash,
           EXISTS (SELECT 1 FROM stock_movements m WHERE m.company_id = i.company_id AND m.item_id = i.id) AS has_movements
      FROM items i WHERE i.company_id = ${companyId}::UUID
  `) as Array<{ id: string; code: string; external_system: string | null; external_ref: string | null; deleted: boolean; item_type: string; inventory_tracked: boolean; is_active: boolean; state_hash: string; has_movements: boolean }>;
  // PO and supplier reference lookups of the tools are case-insensitive (lower(external_system)), so they are read the same way here.
  const pos = (await sql`
    SELECT po_number, lower(external_system) AS external_system, external_ref, round(total * 100)::BIGINT AS cents FROM purchase_orders
    WHERE company_id = ${companyId}::UUID
  `) as Array<{ po_number: string; external_system: string | null; external_ref: string | null; cents: string | number }>;
  const categories = (await sql`
    SELECT id::TEXT AS id, name, external_system, external_ref, is_active,
           md5(row(name, description, code, is_active, external_system, external_ref, extract(epoch FROM updated_at))::TEXT) AS state_hash
      FROM item_categories WHERE company_id = ${companyId}::UUID
  `) as Array<{ id: string; name: string; external_system: string | null; external_ref: string | null; is_active: boolean; state_hash: string }>;
  const suppliers = (await sql`
    SELECT id::TEXT AS id, external_ref FROM suppliers
    WHERE company_id = ${companyId}::UUID AND lower(external_system) = 'sage' AND external_ref IS NOT NULL AND deleted_at IS NULL
  `) as Array<{ id: string; external_ref: string }>;
  const inactive = (await sql`SELECT id::TEXT AS id FROM suppliers WHERE company_id = ${companyId}::UUID AND is_active = false AND deleted_at IS NULL`) as Array<{ id: string }>;
  const linked = (await sql`
    SELECT o.external_ref, count(p.id) FILTER (WHERE p.item_id IS NOT NULL)::INT AS n
      FROM purchase_orders o LEFT JOIN po_items p ON p.purchase_order_id = o.id
     WHERE o.company_id = ${companyId}::UUID AND lower(o.external_system) = 'sage' AND o.external_ref IS NOT NULL GROUP BY o.external_ref
  `) as Array<{ external_ref: string; n: number }>;
  const states = (await sql`
    SELECT o.external_ref,
           md5(row(o.po_number, o.order_date, o.status, o.subtotal, o.tax_amount, o.total, o.supplier_id, extract(epoch FROM o.updated_at),
                   (SELECT string_agg(coalesce(p.item_id::TEXT, '-'), ',' ORDER BY p.sort_order, p.id) FROM po_items p WHERE p.purchase_order_id = o.id))::TEXT) AS state_hash
      FROM purchase_orders o
     WHERE o.company_id = ${companyId}::UUID AND lower(o.external_system) = 'sage' AND o.external_ref IS NOT NULL
  `) as Array<{ external_ref: string; state_hash: string }>;
  const contents = (await sql`
    SELECT o.external_ref, o.supplier_id::TEXT AS supplier_id, to_char(o.expected_delivery_date, 'YYYY-MM-DD') AS delivery_date, o.reference,
           coalesce((SELECT json_agg(json_build_object('description', p.description, 'quantity', p.quantity, 'unit_price', p.unit_price) ORDER BY p.sort_order, p.id)
                       FROM po_items p WHERE p.purchase_order_id = o.id), '[]'::json) AS lines
      FROM purchase_orders o
     WHERE o.company_id = ${companyId}::UUID AND lower(o.external_system) = 'sage' AND o.external_ref IS NOT NULL
  `) as Array<{ external_ref: string; supplier_id: string; delivery_date: string | null; reference: string | null; lines: Array<{ description: string; quantity: string | number; unit_price: string | number }> }>;
  const stock = (await sql`SELECT count(*)::INT AS n FROM stock_movements WHERE company_id = ${companyId}::UUID`) as Array<{ n: number }>;
  const existing = items.map((r): ExistingItem => ({
    // The item and category tools compare external_system EXACTLY (case-sensitive 'sage'): a row stored as 'Sage' is not theirs, nor ours.
    id: String(r.id), code: r.code, system: r.external_system,
    ref: r.external_ref === null ? null : String(r.external_ref), deleted: r.deleted === true,
    itemType: String(r.item_type), inventoryTracked: r.inventory_tracked === true, isActive: r.is_active !== false, stateHash: String(r.state_hash), hasMovements: r.has_movements === true,
  }));
  return {
    itemRefs: new Set(existing.filter((i) => i.system === 'sage' && i.ref !== null && !i.deleted).map((i) => i.ref!)),
    poTotals: new Map(pos.filter((r) => r.external_system === 'sage' && r.external_ref !== null).map((r) => [String(r.external_ref), Number(r.cents)])),
    poStates: new Map(states.map((r) => [String(r.external_ref), String(r.state_hash)])),
    poLinkedLines: new Map(linked.map((r) => [String(r.external_ref), Number(r.n)])),
    poContent: new Map(contents.map((r) => [String(r.external_ref), {
      supplierId: String(r.supplier_id), deliveryDate: r.delivery_date, reference: r.reference,
      lines: r.lines.map((l) => ({ description: String(l.description), quantity: Number(l.quantity), unitPrice: Number(l.unit_price) })),
    }])),
    stockMovements: Number(stock[0]?.n ?? 0),
    items: existing,
    budgetPolicy: await readCheckPolicy(companyId),
    inactiveSuppliers: new Set(inactive.map((r) => String(r.id))),
    categories: categories.map((c) => ({ id: String(c.id), name: c.name, system: c.external_system, ref: c.external_ref === null ? null : String(c.external_ref),
      isActive: c.is_active !== false, stateHash: String(c.state_hash) })),
    supplierSageRefs: new Map(suppliers.map((r) => [String(r.id), String(r.external_ref)])),
    poNumbers: new Map(pos.map((r) => [String(r.po_number), { system: r.external_system, ref: r.external_ref === null ? null : String(r.external_ref) }])),
  };
}
