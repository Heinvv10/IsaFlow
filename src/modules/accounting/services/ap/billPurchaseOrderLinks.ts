/**
 * The bill side of purchase_order_bill_links (migration 1006): which POs a bill is linked to (the MCP bill reads), and
 * the `app` links the REST / MCP bill create and the draft edit write for a bill that names a PO, so the table stays the
 * one list of links (design decisions 4, 11).
 *
 * `planBillLinks` is the amount rule the migration's backfill (`purchase_order_bill_links_backfill`, SQL) also follows;
 * `tests/integration/mcp-po-bill-links-amounts.int.test.ts` runs both on the same bills:
 *   - a PO that the bill's lines name gets the POSTED ex-VAT of those lines (`postedExpenseLines`: what approve posts),
 *     when that is above zero;
 *   - a PO named only by the header (or whose lines post nothing) gets the bill's subtotal less what the line-linked POs
 *     hold; of several such POs only the lowest id is linked; nothing when that is not above zero.
 * Only a PO of the bill's own company and supplier in a linkable status (`LINKABLE_PO_STATUSES`) is linked.
 */
import { sql, type TxSql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { toCents } from '../budgets/grid/cents';
import { postedExpenseLines } from '../budgets/remainingCommitted';
import { SUPPLIER_INVOICE_LINE_ORDER_BY } from './supplierInvoiceLineOrder';
import { LINKABLE_PO_STATUSES } from './purchaseOrderBillLinkTypes';

type Db = typeof sql | TxSql;

/** The PO ids each bill is linked to, oldest link first. A bill with none is absent from the map. */
export async function purchaseOrderIdsByBill(companyId: string, billIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (billIds.length === 0) return out;
  const rows = (await sql`
    SELECT l.supplier_invoice_id::TEXT AS bill, l.purchase_order_id::TEXT AS po
      FROM purchase_order_bill_links l
     WHERE l.company_id = ${companyId}::UUID AND l.supplier_invoice_id = ANY(${[...billIds]}::UUID[])
     ORDER BY l.created_at, l.id
  `) as DbRow[];
  for (const r of rows) {
    const bill = String(r.bill).toLowerCase();
    out.set(bill, [...(out.get(bill) ?? []), String(r.po)]);
  }
  return out;
}

export interface BillLinkPlanInput {
  subtotalCents: number;
  /** The bill's lines: the PO each names (null: none, or a PO that cannot be linked) and what it posts. */
  lines: ReadonlyArray<{ poId: string | null; postedCents: number }>;
  /** The header PO when it can be linked. */
  headerPoId: string | null;
}

export function planBillLinks(input: BillLinkPlanInput): Array<{ poId: string; amountCents: number }> {
  const sums = new Map<string, number>();
  for (const l of input.lines) if (l.poId) sums.set(l.poId, (sums.get(l.poId) ?? 0) + l.postedCents);
  if (input.headerPoId && !sums.has(input.headerPoId)) sums.set(input.headerPoId, 0);
  const positive = [...sums].filter(([, c]) => c > 0);
  const posTotal = positive.reduce((s, [, c]) => s + c, 0);
  const fallback = [...sums].filter(([, c]) => c <= 0).map(([po]) => po).sort()[0];
  const out = positive.map(([poId, amountCents]) => ({ poId, amountCents }));
  if (fallback && input.subtotalCents - posTotal > 0) out.push({ poId: fallback, amountCents: input.subtotalCents - posTotal });
  return out;
}

/**
 * Writes the `app` links a bill's header and lines call for (see the file header). Existing links are left (ON CONFLICT
 * DO NOTHING on the pair). `db`: the transaction of the bill's own create, so the rows it just wrote are seen.
 * A bill that is cancelled or deleted, or names no linkable PO, gets none.
 */
export async function recordBillLinks(companyId: string, billId: string, userId: string, db: Db = sql): Promise<number> {
  const bill = ((await db`
    SELECT si.* FROM supplier_invoices si
     WHERE si.id = ${billId}::UUID AND si.company_id = ${companyId}::UUID AND si.status <> 'cancelled' AND si.deleted_at IS NULL
  `) as DbRow[])[0];
  if (!bill) return 0;
  const items = (await db`
    SELECT sii.*, pi.purchase_order_id::TEXT AS item_po FROM supplier_invoice_items sii
      LEFT JOIN po_items pi ON pi.id = sii.po_item_id
     WHERE sii.supplier_invoice_id = ${billId}::UUID
    ${sql.unsafe(SUPPLIER_INVOICE_LINE_ORDER_BY)}
  `) as DbRow[];
  const header = bill.purchase_order_id ? String(bill.purchase_order_id).toLowerCase() : null;
  const named = [...new Set([header, ...items.map((i) => (i.item_po ? String(i.item_po).toLowerCase() : null))].filter((v): v is string => !!v))];
  if (named.length === 0) return 0;
  const usable = new Set(((await db`
    SELECT id::TEXT AS id FROM purchase_orders
     WHERE id = ANY(${named}::UUID[]) AND company_id = ${companyId}::UUID AND supplier_id = ${String(bill.supplier_id)}::UUID
       AND status = ANY(${[...LINKABLE_PO_STATUSES]}::TEXT[])
  `) as DbRow[]).map((r) => String(r.id).toLowerCase()));
  const posted = new Map<string, number>();
  for (const l of postedExpenseLines(bill, items)) posted.set(String(l.description), (posted.get(String(l.description)) ?? 0) + toCents(l.debit));
  const plan = planBillLinks({
    subtotalCents: toCents(Number(bill.subtotal)),
    lines: items.map((i) => {
      const po = i.item_po ? String(i.item_po).toLowerCase() : null;
      return { poId: po && usable.has(po) ? po : null, postedCents: posted.get(String(i.id)) ?? 0 };
    }),
    headerPoId: header && usable.has(header) ? header : null,
  });
  for (const p of plan) {
    await db`
      INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source, created_by)
      VALUES (${companyId}::UUID, ${p.poId}::UUID, ${billId}::UUID, ${(p.amountCents / 100).toFixed(2)}::NUMERIC, 'app', ${userId})
      ON CONFLICT (company_id, purchase_order_id, supplier_invoice_id) DO NOTHING
    `;
  }
  return plan.length;
}

/**
 * After a draft edit: the bill's `app` links are made again from what it now says (amounts follow its new lines and
 * subtotal). Links another writer made (`mcp`, `backfill`) are not touched.
 */
export async function refreshAppBillLinks(companyId: string, billId: string, userId: string, db: Db = sql): Promise<void> {
  await db`DELETE FROM purchase_order_bill_links WHERE company_id = ${companyId}::UUID AND supplier_invoice_id = ${billId}::UUID AND source = 'app'`;
  await recordBillLinks(companyId, billId, userId, db);
}

/** Migration 1006: a PO with bills linked keeps its supplier (a link joins one supplier's PO and bill). True when changing it to `supplierId` must be refused. */
export async function poSupplierChangeBlocked(companyId: string, poId: string, supplierId: string): Promise<boolean> {
  const linked = (await sql`
    SELECT 1 FROM purchase_order_bill_links l JOIN purchase_orders po ON po.id = l.purchase_order_id AND po.company_id = l.company_id
     WHERE po.id = ${poId}::UUID AND po.company_id = ${companyId}::UUID AND po.supplier_id IS DISTINCT FROM ${supplierId}::UUID LIMIT 1
  `) as DbRow[];
  return linked.length > 0;
}
