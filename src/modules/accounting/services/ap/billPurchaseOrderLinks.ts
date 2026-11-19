/**
 * The bill side of purchase_order_bill_links (migration 1006): which POs a bill is linked to (the MCP bill reads), and
 * the `app` links the REST / MCP bill create and the draft edit write for a bill that names a PO, so the table stays the
 * one list of links (design decisions 4, 11).
 *
 * `planBillLinks` is the amount rule the migration's backfill (`purchase_order_bill_links_backfill`, SQL) also follows;
 * `tests/integration/mcp-po-bill-links-amounts.int.test.ts` runs both on the same bills:
 *   - a PO that the bill's lines name gets the POSTED ex-VAT of those lines (`postedExpenseLines`: what approve posts),
 *     when that is above zero, never more than the bill's subtotal;
 *   - a PO named only by the header (or whose lines post nothing) gets the bill's subtotal less what the line-linked POs
 *     hold (and, here only, less the bill's other links: an `mcp` link or an adopted one); of several such POs only the
 *     lowest id is linked; nothing when that is not above zero.
 * Only a PO of the bill's own company and supplier in a linkable status (`LINKABLE_PO_STATUSES`) is linked.
 *
 * The sync (`recordBillLinks`, also `refreshAppBillLinks`) is a DIFF: a link that is already right is not touched (so a
 * draft edit takes no lock on the PO and keeps its `created_at` order), a stale one is deleted and made again, and only
 * links this writer owns (`app` / `backfill` with no external reference) are ever deleted. The PO rows it reads are taken
 * `FOR KEY SHARE`: the lock the link's FK takes anyway, which does NOT conflict with the link tool's `FOR NO KEY UPDATE`
 * (so a draft edit holding its bill and the link tool holding the PO cannot deadlock), but does wait for a PO cancel /
 * approve / goods receipt (`FOR UPDATE`) and then re-reads the status, so a PO cancelled meanwhile gets no link.
 */
import { sql, type TxSql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { toCents } from '../budgets/grid/cents';
import { BILLED_STATUSES, postedExpenseLines } from '../budgets/remainingCommitted';
import { SUPPLIER_INVOICE_LINE_ORDER_BY } from './supplierInvoiceLineOrder';
import { withRowLockBudget } from '../core/rowLockBudget';
import { LINKABLE_PO_STATUSES } from './purchaseOrderBillLinkTypes';
import { PurchaseOrderLockTimeoutError } from './purchaseOrderErrors';

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
  /** What the bill's links this writer does not own already hold (an `mcp` or adopted link); 0 on a fresh bill. */
  heldCents?: number;
}

export function planBillLinks(input: BillLinkPlanInput): Array<{ poId: string; amountCents: number }> {
  const sums = new Map<string, number>();
  for (const l of input.lines) if (l.poId) sums.set(l.poId, (sums.get(l.poId) ?? 0) + l.postedCents);
  if (input.headerPoId && !sums.has(input.headerPoId)) sums.set(input.headerPoId, 0);
  const positive = [...sums].filter(([, c]) => c > 0).map(([poId, c]) => ({ poId, amountCents: Math.min(c, input.subtotalCents) }));
  const posTotal = positive.reduce((s, p) => s + p.amountCents, 0);
  const fallback = [...sums].filter(([, c]) => c <= 0).map(([po]) => po).sort()[0];
  const left = input.subtotalCents - posTotal - (input.heldCents ?? 0);
  return fallback && left > 0 ? [...positive, { poId: fallback, amountCents: left }] : positive;
}

/**
 * Makes the bill's `app` links what its header and lines call for (see the file header). `db`: the transaction of the
 * bill's own create or edit, so the rows it just wrote are seen. A bill that is cancelled or deleted gets none made.
 * Returns how many links it wrote.
 */
export async function recordBillLinks(companyId: string, billId: string, userId: string, db: Db = sql): Promise<number> {
  const bill = ((await db`
    SELECT si.* FROM supplier_invoices si
     WHERE si.id = ${billId}::UUID AND si.company_id = ${companyId}::UUID AND si.status <> 'cancelled' AND si.deleted_at IS NULL
  `) as DbRow[])[0];
  if (!bill) return 0;
  const items = (await db`
    SELECT sii.*, pi.purchase_order_id::TEXT AS item_po FROM supplier_invoice_items sii
      JOIN supplier_invoices si ON si.id = sii.supplier_invoice_id AND si.company_id = ${companyId}::UUID
      LEFT JOIN po_items pi ON pi.id = sii.po_item_id
     WHERE sii.supplier_invoice_id = ${billId}::UUID
    ${sql.unsafe(SUPPLIER_INVOICE_LINE_ORDER_BY)}
  `) as DbRow[];
  const header = bill.purchase_order_id ? String(bill.purchase_order_id).toLowerCase() : null;
  const named = [...new Set([header, ...items.map((i) => (i.item_po ? String(i.item_po).toLowerCase() : null))].filter((v): v is string => !!v))];
  // Bounded like every PO lock (5 s, typed retryable PURCHASE_ORDER_LOCK_TIMEOUT): a PO held FOR UPDATE by an edit / cancel / approval must
  // not pin a bill create or a draft edit; the statement is before this sync's first write, and the caller's transaction takes the rest back.
  const usable = new Set(named.length === 0 ? [] : (await withRowLockBudget(async () => (await db`
    SELECT id::TEXT AS id FROM purchase_orders
     WHERE id = ANY(${named}::UUID[]) AND company_id = ${companyId}::UUID AND supplier_id = ${String(bill.supplier_id)}::UUID
       AND status = ANY(${[...LINKABLE_PO_STATUSES]}::TEXT[])
     ORDER BY id FOR KEY SHARE
  `) as DbRow[], () => new PurchaseOrderLockTimeoutError())).map((r) => String(r.id).toLowerCase()));
  const posted = new Map<string, number>();
  for (const l of postedExpenseLines(bill, items)) posted.set(String(l.description), (posted.get(String(l.description)) ?? 0) + toCents(l.debit));

  const links = (await db`
    SELECT id::TEXT AS id, purchase_order_id::TEXT AS po, amount::TEXT AS amount, closed_po_from_status AS closed,
           (source IN ('app', 'backfill') AND external_ref IS NULL) AS owned
      FROM purchase_order_bill_links WHERE company_id = ${companyId}::UUID AND supplier_invoice_id = ${billId}::UUID
  `) as DbRow[];
  const plan = planBillLinks({
    subtotalCents: toCents(Number(bill.subtotal)),
    lines: items.map((i) => {
      const po = i.item_po ? String(i.item_po).toLowerCase() : null;
      return { poId: po && usable.has(po) ? po : null, postedCents: posted.get(String(i.id)) ?? 0 };
    }),
    headerPoId: header && usable.has(header) ? header : null,
    heldCents: links.filter((l) => l.owned !== true).reduce((s, l) => s + toCents(Number(l.amount)), 0),
  });
  const want = new Map(plan.map((p) => [p.poId, p.amountCents]));
  const owned = links.filter((l) => l.owned === true);
  const stale = owned.filter((l) => want.get(String(l.po).toLowerCase()) !== toCents(Number(l.amount)));
  if (stale.length > 0) await db`DELETE FROM purchase_order_bill_links WHERE company_id = ${companyId}::UUID AND id = ANY(${stale.map((l) => String(l.id))}::UUID[])`;
  const kept = new Set(owned.filter((l) => !stale.includes(l)).map((l) => String(l.po).toLowerCase()));
  // A closing record (closed_po_from_status) on a link this sync remakes is carried over, never lost with the old row (only while the PO
  // is closed: the table's guard refuses a record on any other).
  const carry = new Map(stale.filter((l) => l.closed != null).map((l) => [String(l.po).toLowerCase(), String(l.closed)]));
  let written = 0;
  for (const p of plan) {
    if (kept.has(p.poId)) continue;
    const done = (await db`
      INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source, created_by, closed_po_from_status)
      VALUES (${companyId}::UUID, ${p.poId}::UUID, ${billId}::UUID, ${(p.amountCents / 100).toFixed(2)}::NUMERIC, 'app', ${userId},
        (SELECT ${carry.get(p.poId) ?? null}::TEXT WHERE EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = ${p.poId}::UUID AND po.company_id = ${companyId}::UUID AND po.status = 'closed')))
      ON CONFLICT (company_id, purchase_order_id, supplier_invoice_id) DO NOTHING RETURNING id
    `) as DbRow[];
    written += done.length;
    if (done.length > 0) carry.delete(p.poId);
  }
  // A record whose link is gone for good (the PO is no longer named) moves to a link of that PO on a billed bill.
  for (const [po, from] of carry) {
    await db`
      UPDATE purchase_order_bill_links SET closed_po_from_status = ${from}
       WHERE EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = ${po}::UUID AND po.company_id = ${companyId}::UUID AND po.status = 'closed')
         AND id = (SELECT l.id FROM purchase_order_bill_links l JOIN supplier_invoices si ON si.id = l.supplier_invoice_id AND si.company_id = l.company_id
                    WHERE l.company_id = ${companyId}::UUID AND l.purchase_order_id = ${po}::UUID AND si.status = ANY(${[...BILLED_STATUSES]}::TEXT[])
                      AND si.deleted_at IS NULL AND l.closed_po_from_status IS NULL
                    ORDER BY NOT (l.source IN ('app', 'backfill') AND l.external_ref IS NULL) DESC, l.created_at, l.id LIMIT 1)
    `;
  }
  return written;
}

/** After a draft edit: the same diff (amounts follow the bill's new lines and subtotal). Links another writer made are not touched. */
export const refreshAppBillLinks = recordBillLinks;

/** Migration 1006: a PO with bills linked keeps its supplier (a link joins one supplier's PO and bill). The refusal to answer, or null when the change is allowed. */
export async function poSupplierChangeBlocked(companyId: string, poId: string, supplierId: string): Promise<string | null> {
  const linked = (await sql`
    SELECT 1 FROM purchase_order_bill_links l JOIN purchase_orders po ON po.id = l.purchase_order_id AND po.company_id = l.company_id
     WHERE po.id = ${poId}::UUID AND po.company_id = ${companyId}::UUID AND po.supplier_id IS DISTINCT FROM ${supplierId}::UUID LIMIT 1
  `) as DbRow[];
  return linked.length > 0 ? 'Bills are linked to this purchase order, so its supplier cannot change. Unlink them first.' : null;
}
