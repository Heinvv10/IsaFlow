/**
 * link_bills_to_purchase_order: the facts, read under the locks (design decision 13). Lock order, one 5 s budget for the
 * whole section (`withRowLockBudget`, one deadline): the call's external-reference advisory locks (sorted), then the
 * PO rows `FOR UPDATE` in id order, then the bill rows in id order. A row held past the budget is a typed, retryable
 * refusal; nothing has been written by then. Every query is company-scoped (po_items and grn_items have no company_id:
 * their tenancy goes through the parent PO).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { lockExternalRef } from '../core/externalRefService';
import { RowLockTimeoutError, ROW_LOCK_BUDGET_MS, withRowLockBudget } from '../core/rowLockBudget';
import { toCents } from '../budgets/grid/cents';
import { postedExpenseLines } from '../budgets/remainingCommitted';
import { SUPPLIER_INVOICE_LINE_ORDER_BY } from './supplierInvoiceLineOrder';
import { PurchaseOrderLockTimeoutError } from './purchaseOrderErrors';
import type { BillFacts, BillLineFacts, ExistingLink, LinkRequest, PoFacts } from './purchaseOrderBillLinkTypes';

export interface LinkFacts {
  resolvedPo: Map<number, string>;
  pos: Map<string, PoFacts>;
  bills: Map<string, BillFacts>;
  poItemOwner: Map<string, string>;
  existing: ExistingLink[];
  refOwners: Map<string, ExistingLink>;
}

const low = (v: unknown) => String(v).toLowerCase();

export function existingLinkOf(r: DbRow): ExistingLink {
  return {
    id: low(r.id), poId: low(r.purchase_order_id), billId: low(r.supplier_invoice_id),
    billStatus: r.bill_deleted === true ? 'deleted' : String(r.bill_status), amountCents: toCents(Number(r.amount)),
    refSystem: r.external_system == null ? null : String(r.external_system),
    refRef: r.external_ref == null ? null : String(r.external_ref), closedFrom: r.closed_po_from_status == null ? null : String(r.closed_po_from_status),
  };
}

export const LINK_SELECT_COLUMNS = `l.id, l.purchase_order_id, l.supplier_invoice_id, l.amount, l.external_system, l.external_ref,
  l.closed_po_from_status`;

/** Resolve each request's PO (po_id or po_number, this company's only), without a lock. */
async function resolvePos(companyId: string, requests: readonly LinkRequest[]): Promise<Map<number, string>> {
  const ids = requests.map((r) => r.poId).filter((v): v is string => v !== null);
  const numbers = requests.map((r) => r.poNumber).filter((v): v is string => v !== null);
  const rows = (await sql`
    SELECT id::TEXT AS id, po_number FROM purchase_orders
     WHERE company_id = ${companyId}::UUID AND (id = ANY(${ids}::UUID[]) OR po_number = ANY(${numbers}::TEXT[]))
  `) as DbRow[];
  const byId = new Map(rows.map((r) => [low(r.id), low(r.id)]));
  const byNumber = new Map(rows.map((r) => [String(r.po_number), low(r.id)]));
  const out = new Map<number, string>();
  for (const r of requests) {
    const id = r.poId !== null ? byId.get(r.poId) : byNumber.get(r.poNumber!);
    if (id) out.set(r.index, id);
  }
  return out;
}

export async function readLinkFacts(companyId: string, requests: readonly LinkRequest[]): Promise<LinkFacts> {
  const refs = [...new Map(requests.filter((r) => r.ref).map((r) => [`${r.ref!.system}\u0000${r.ref!.ref}`, r.ref!])).entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [, ref] of refs) await lockExternalRef(companyId, 'po_bill_link', ref.system, ref.ref);

  const resolvedPo = await resolvePos(companyId, requests);
  const poIds = [...new Set(resolvedPo.values())].sort();
  const billIds = [...new Set(requests.map((r) => r.billId))].sort();
  const deadline = Date.now() + ROW_LOCK_BUDGET_MS;

  const poRows = await withRowLockBudget(async () => (await sql`
    SELECT id::TEXT AS id, po_number, status, supplier_id::TEXT AS supplier_id, subtotal FROM purchase_orders
     WHERE company_id = ${companyId}::UUID AND id = ANY(${poIds}::UUID[]) ORDER BY id FOR NO KEY UPDATE
  `) as DbRow[], () => new PurchaseOrderLockTimeoutError(), { deadline });
  // FOR NO KEY UPDATE, not FOR UPDATE: it still excludes another link / unlink call and a PO cancel / approve / goods receipt
  // (FOR UPDATE), but not the KEY SHARE a draft edit's link insert takes on the PO through the FK, which a draft edit holding
  // its bill row would otherwise wait on while this call waits for that bill (a deadlock; review round 2, M1).
  // The links of a locked PO change under this lock EXCEPT by the app writers (a bill's create / draft edit), which hold only the
  // bill's row and a KEY SHARE on the PO. A link such a writer commits after this read is on a DRAFT bill, which is not billed
  // and so cannot move fully_billed; a draft this call reads is locked below, so it cannot be approved under the decision.
  const held = (await sql`
    SELECT DISTINCT l.supplier_invoice_id::TEXT AS bill FROM purchase_order_bill_links l
     WHERE l.company_id = ${companyId}::UUID AND l.purchase_order_id = ANY(${poIds}::UUID[])
  `) as DbRow[];
  const lockIds = [...new Set([...billIds, ...held.map((r) => low(r.bill))])].sort();
  const billRows = (await withRowLockBudget(async () => (await sql`
    SELECT si.* FROM supplier_invoices si
     WHERE si.company_id = ${companyId}::UUID AND si.id = ANY(${lockIds}::UUID[]) AND si.deleted_at IS NULL ORDER BY si.id FOR UPDATE
  `) as DbRow[], () => new RowLockTimeoutError('A bill in this call'), { deadline })).filter((b) => billIds.includes(low(b.id)));

  const items = (await sql`
    SELECT sii.*, po.id::TEXT AS item_po_id FROM supplier_invoice_items sii
      LEFT JOIN po_items pi ON pi.id = sii.po_item_id
      LEFT JOIN purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${companyId}::UUID
     WHERE sii.supplier_invoice_id = ANY(${billIds}::UUID[])
       AND EXISTS (SELECT 1 FROM supplier_invoices si WHERE si.id = sii.supplier_invoice_id AND si.company_id = ${companyId}::UUID)
    ${sql.unsafe(SUPPLIER_INVOICE_LINE_ORDER_BY)}
  `) as DbRow[];
  const bills = new Map<string, BillFacts>();
  for (const b of billRows) {
    const own = items.filter((i) => low(i.supplier_invoice_id) === low(b.id));
    const posted = new Map<string, number>();
    for (const l of postedExpenseLines(b, own)) posted.set(String(l.description), (posted.get(String(l.description)) ?? 0) + toCents(l.debit));
    const lines: BillLineFacts[] = own.map((i) => ({
      id: low(i.id), poItemId: i.po_item_id == null ? null : low(i.po_item_id), poItemPoId: i.item_po_id == null ? null : low(i.item_po_id),
      postedCents: posted.get(String(i.id)) ?? 0,
    }));
    bills.set(low(b.id), {
      id: low(b.id), invoiceNumber: String(b.invoice_number), status: String(b.status), supplierId: low(b.supplier_id),
      subtotalCents: toCents(Number(b.subtotal)), lines,
    });
  }

  const itemIds = requests.flatMap((r) => r.lines.map((l) => l.poItemId));
  const owners = (await sql`
    SELECT pi.id::TEXT AS id, pi.purchase_order_id::TEXT AS po FROM po_items pi
      JOIN purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${companyId}::UUID
     WHERE pi.id = ANY(${itemIds}::UUID[])
  `) as DbRow[];

  const links = (await sql`
    SELECT ${sql.unsafe(LINK_SELECT_COLUMNS)}, si.status AS bill_status, (si.deleted_at IS NOT NULL) AS bill_deleted
      FROM purchase_order_bill_links l
      JOIN supplier_invoices si ON si.id = l.supplier_invoice_id AND si.company_id = l.company_id
     WHERE l.company_id = ${companyId}::UUID
       AND (l.purchase_order_id = ANY(${poIds}::UUID[]) OR l.supplier_invoice_id = ANY(${billIds}::UUID[]))
  `) as DbRow[];
  const refOwners = new Map<string, ExistingLink>();
  if (refs.length > 0) {
    const owned = (await sql`
      SELECT ${sql.unsafe(LINK_SELECT_COLUMNS)}, si.status AS bill_status, (si.deleted_at IS NOT NULL) AS bill_deleted
        FROM purchase_order_bill_links l
        JOIN supplier_invoices si ON si.id = l.supplier_invoice_id AND si.company_id = l.company_id
       WHERE l.company_id = ${companyId}::UUID
         AND (l.external_system, l.external_ref) IN (SELECT * FROM unnest(${refs.map(([, r]) => r.system)}::TEXT[], ${refs.map(([, r]) => r.ref)}::TEXT[]))
    `) as DbRow[];
    for (const r of owned) refOwners.set(`${r.external_system}\u0000${r.external_ref}`, existingLinkOf(r));
  }
  return {
    resolvedPo,
    pos: new Map(poRows.map((r) => [low(r.id), {
      id: low(r.id), poNumber: String(r.po_number), status: String(r.status), supplierId: low(r.supplier_id), subtotalCents: toCents(Number(r.subtotal)),
    }])),
    bills,
    poItemOwner: new Map(owners.map((r) => [low(r.id), low(r.po)])),
    existing: links.map(existingLinkOf),
    refOwners,
  };
}
