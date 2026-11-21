/**
 * link_bills_to_purchase_order: the facts, read under the locks (design decision 13). Lock order, one 5 s budget for the
 * whole section (`withRowLockBudget`, one deadline): the call's external-reference advisory locks (sorted), then the
 * PO rows `FOR NO KEY UPDATE` in id order, then the call's own bills `FOR UPDATE` in id order (one statement, waiting), then every
 * other bill tying those POs `FOR SHARE NOWAIT` (one statement). A row held past the budget, or a busy tied bill, is a typed,
 * retryable refusal; nothing has been written by then. Every query is company-scoped (po_items and grn_items have no company_id:
 * their tenancy goes through the parent PO).
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { lockExternalRef } from '../core/externalRefService';
import { RowLockTimeoutError, ROW_LOCK_BUDGET_MS, withRowLockBudget } from '../core/rowLockBudget';
import { toCents } from '../budgets/grid/cents';
import { BILLED_STATUSES, poBillingBasisCents, postedExpenseLines } from '../budgets/remainingCommitted';
import { billTies } from '../budgets/billAttribution';
import { SUPPLIER_INVOICE_LINE_ORDER_BY } from './supplierInvoiceLineOrder';
import { PurchaseOrderLockTimeoutError, TiedBillBusyError } from './purchaseOrderErrors';
import type { BillFacts, BillLineFacts, ExistingLink, LinkRequest, PoFacts } from './purchaseOrderBillLinkTypes';

export interface LinkFacts {
  resolvedPo: Map<number, string>;
  pos: Map<string, PoFacts>;
  bills: Map<string, BillFacts>;
  poItemOwner: Map<string, string>;
  existing: ExistingLink[];
  refOwners: Map<string, ExistingLink>;
  unlinkedBilled: Map<string, Array<{ billId: string; cents: number }>>;
  heldByHeader: Map<string, Array<{ poId: string; poNumber: string; status: string; cents: number }>>;
}

const low = (v: unknown) => String(v).toLowerCase();

export function existingLinkOf(r: DbRow): ExistingLink {
  return {
    id: low(r.id), poId: low(r.purchase_order_id), billId: low(r.supplier_invoice_id),
    billStatus: r.bill_deleted === true ? 'deleted' : String(r.bill_status), amountCents: toCents(Number(r.amount)), storedAmountCents: toCents(Number(r.amount)),
    refSystem: r.external_system == null ? null : String(r.external_system),
    refRef: r.external_ref == null ? null : String(r.external_ref),
  };
}

export const LINK_SELECT_COLUMNS = `l.id, l.purchase_order_id, l.supplier_invoice_id, l.amount, l.external_system, l.external_ref`;

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

/** Breaker r15 F1: a busy tie is retried this many times, jittered, before the call is refused (never a lock wait: no cycle). */
export const TIED_BILL_ATTEMPTS = 5;
const jitter = () => new Promise<void>((res) => setTimeout(res, 10 + Math.floor(Math.random() * 41)));

/**
 * The bill locks, after the POs: the call's OWN bills FOR UPDATE (waiting, under the budget), then every other non-cancelled bill
 * tying its POs FOR SHARE NOWAIT. Each attempt runs in its own savepoint; a busy tie rolls it back, which RELEASES the own-bill
 * locks it took, so two links whose own bills tie each other's PO do not hold each other off for every attempt (breaker r15 M);
 * after a 10-50 ms jittered sleep it tries again, up to TIED_BILL_ATTEMPTS, then refuses (TiedBillBusyError, retryable).
 */
async function lockBills(companyId: string, poIds: readonly string[], billIds: readonly string[], pos: readonly DbRow[], deadline: number): Promise<void> {
  const ids = [...poIds];
  const own = [...billIds];
  for (let attempt = 1; ; attempt++) {
    try {
      await withSavepoint('link_bill_locks', async () => {
        await withRowLockBudget(async () => sql`
          SELECT 1 FROM supplier_invoices WHERE company_id = ${companyId}::UUID AND id = ANY(${own}::UUID[]) ORDER BY id FOR UPDATE
        `, () => new RowLockTimeoutError('A bill in this call'), { deadline });
        await sql`
          SELECT 1 FROM supplier_invoices si
           WHERE si.company_id = ${companyId}::UUID AND si.status <> 'cancelled' AND NOT (si.id = ANY(${own}::UUID[])) AND (
                 si.purchase_order_id = ANY(${ids}::UUID[])
              OR si.id IN (SELECT l.supplier_invoice_id FROM purchase_order_bill_links l
                            WHERE l.company_id = ${companyId}::UUID AND l.purchase_order_id = ANY(${ids}::UUID[]))
              OR si.id IN (SELECT x.supplier_invoice_id FROM supplier_invoice_items x JOIN po_items pi ON pi.id = x.po_item_id
                            WHERE pi.purchase_order_id = ANY(${ids}::UUID[])))
           ORDER BY si.id FOR SHARE NOWAIT
        `;
      });
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== '55P03') throw err;
      if (attempt >= TIED_BILL_ATTEMPTS || Date.now() >= deadline) {
        throw new TiedBillBusyError(pos.filter((r) => ids.includes(low(r.id))).map((r) => String(r.po_number)).sort());
      }
      await jitter();
    }
  }
}

export async function readLinkFacts(companyId: string, requests: readonly LinkRequest[]): Promise<LinkFacts> {
  const refs = [...new Map(requests.filter((r) => r.ref).map((r) => [`${r.ref!.system}\u0000${r.ref!.ref}`, r.ref!])).entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [, ref] of refs) await lockExternalRef(companyId, 'po_bill_link', ref.system, ref.ref);

  const resolvedPo = await resolvePos(companyId, requests);
  const poIds = [...new Set(resolvedPo.values())].sort();
  const billIds = [...new Set(requests.map((r) => r.billId))].sort();
  const deadline = Date.now() + ROW_LOCK_BUDGET_MS;
  // The POs the call's bills name in their header are locked WITH the call's POs, in the one sorted list, before any bill (review
  // r5 H1 / L3): a link may take a header residual from such a PO, so its status and billing must hold under the decision.
  const headerIds = ((await sql`
    SELECT DISTINCT si.purchase_order_id::TEXT AS po FROM supplier_invoices si
     WHERE si.company_id = ${companyId}::UUID AND si.id = ANY(${billIds}::UUID[]) AND si.purchase_order_id IS NOT NULL
  `) as DbRow[]).map((r) => low(r.po));
  const lockPoIds = [...new Set([...poIds, ...headerIds])].sort();

  const lockedPos = await withRowLockBudget(async () => (await sql`
    SELECT id::TEXT AS id, po_number, status, supplier_id::TEXT AS supplier_id, subtotal FROM purchase_orders
     WHERE company_id = ${companyId}::UUID AND id = ANY(${lockPoIds}::UUID[]) ORDER BY id FOR NO KEY UPDATE
  `) as DbRow[], () => new PurchaseOrderLockTimeoutError(), { deadline });
  const poRows = lockedPos.filter((r) => poIds.includes(low(r.id)));
  // FOR NO KEY UPDATE, not FOR UPDATE: it still excludes another link / unlink call and a PO cancel / approve / goods receipt
  // (FOR UPDATE), but not the KEY SHARE a draft edit's link insert takes on the PO through the FK, which a draft edit holding
  // its bill row would otherwise wait on while this call waits for that bill (a deadlock; review round 2, M1).
  // The links of a locked PO change under this lock EXCEPT by the app writers (a bill's create / draft edit), which hold only the
  // bill's row and a KEY SHARE on the PO. A link such a writer commits after this read is on a DRAFT bill, which is not billed
  // and so cannot move fully_billed; a draft this call reads is taken below (FOR SHARE NOWAIT), so it cannot be approved under the decision.
  // The CALL'S OWN bills (the ones it links): FOR UPDATE, waiting under the budget, ONE statement in id order. Then (breaker r12 F2 /
  // r13, review r14 M3) every OTHER bill that ties a requested PO (a link row, its header or its lines; a cancelled
  // one is terminal and skipped) is taken FOR SHARE NOWAIT, so billed / fully_billed cannot move under the close decision and a
  // cancel or delete of one that is done but uncommitted cannot be read as still billing. NOWAIT never waits (no cycle, whatever
  // order another writer takes them in); one still busy after TIED_BILL_ATTEMPTS jittered attempts (breaker r15 F1) refuses the
  // whole call, retryably, before any write (dry run too).
  await lockBills(companyId, poIds, billIds, lockedPos, deadline);
  const billRows = ((await sql`
    SELECT si.* FROM supplier_invoices si
     WHERE si.company_id = ${companyId}::UUID AND si.id = ANY(${billIds}::UUID[]) AND si.deleted_at IS NULL ORDER BY si.id
  `) as DbRow[]);

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
  // One attribution (budgets/billAttribution, PR #1703 isaflow-c8): a link whose bill's lines name its PO holds the lines' posted
  // amount, whatever amount it stored (a link written with an explicit amount beside lines before the planner checked them).
  const existing = links.map(existingLinkOf);
  const linkPos = [...new Set(existing.map((l) => l.poId))];
  const ties = await billTies(companyId, [...new Set([...linkPos, ...poIds])], { statuses: null });
  const byLines = new Map(ties.filter((t) => t.via === 'lines').map((t) => [`${t.billId}|${t.poId}`, t.cents]));
  for (const l of existing) { const c = byLines.get(`${l.billId}|${l.poId}`); if (c !== undefined) l.amountCents = c; }
  // The billed ties of the call's POs with NO link row (by header, or by lines saved while the PO was not linkable; review r3 M2):
  // billed counts them as get_purchase_order does, so the close decision and its dry run agree with it.
  const pairLinked = new Set(existing.map((l) => `${l.billId}|${l.poId}`));
  const unlinkedBilled = new Map<string, Array<{ billId: string; cents: number }>>();
  for (const t of ties) {
    if (t.via === 'link' || pairLinked.has(`${t.billId}|${t.poId}`) || t.deleted || !(BILLED_STATUSES as readonly string[]).includes(t.status)
      || !poIds.includes(t.poId)) continue;
    unlinkedBilled.set(t.poId, [...(unlinkedBilled.get(t.poId) ?? []), { billId: t.billId, cents: t.cents }]);
  }
  // The POs the call's bills tie only by their header, and what each holds there (breaker R3-4).
  const headerPos = [...new Set(billRows.map((b) => (b.purchase_order_id == null ? null : low(b.purchase_order_id))).filter((v): v is string => !!v))];
  const heldByHeader = new Map<string, Array<{ poId: string; poNumber: string; status: string; cents: number }>>();
  if (headerPos.length > 0) {
    // Locked above; a header changed between that read and the bill lock names a PO read here unlocked (its status as it is now).
    const headerPo = new Map(((await sql`
      SELECT id::TEXT AS id, po_number, status FROM purchase_orders WHERE company_id = ${companyId}::UUID AND id = ANY(${headerPos}::UUID[])
    `) as DbRow[]).map((r) => [low(r.id), { poNumber: String(r.po_number), status: String(r.status) }]));
    for (const t of await billTies(companyId, headerPos, { statuses: null })) {
      if (t.via !== 'header' || !billIds.includes(t.billId)) continue;
      const h = headerPo.get(t.poId);
      heldByHeader.set(t.billId, [...(heldByHeader.get(t.billId) ?? []), { poId: t.poId, poNumber: h?.poNumber ?? t.poId, status: h?.status ?? 'unknown', cents: t.cents }]);
    }
  }
  // Fully billed against max(header subtotal, lines' total), as 1022 closes on (review r7 M2).
  const basis = await poBillingBasisCents(companyId, poRows.map((r) => low(r.id)));
  return {
    resolvedPo,
    pos: new Map(poRows.map((r) => [low(r.id), {
      id: low(r.id), poNumber: String(r.po_number), status: String(r.status), supplierId: low(r.supplier_id), subtotalCents: basis.get(low(r.id)) ?? 0, headerSubtotalCents: toCents(Number(r.subtotal ?? 0)),
    }])),
    bills,
    poItemOwner: new Map(owners.map((r) => [low(r.id), low(r.po)])),
    existing,
    refOwners,
    unlinkedBilled,
    heldByHeader,
  };
}
