/**
 * A bill's goods received note (`supplier_invoices.grn_id`, review M1 of docs/design/mcp-goods-received.md). The column has NO foreign
 * key (migration 201 created it bare; 246b's ADD COLUMN ... REFERENCES was skipped), so nothing in the database ties a bill to a note:
 * a bill could name a cancelled note, another company's note or no note at all, and a bill written while a cancel ran could end on a
 * cancelled note. Writers of the column (census): `createSupplierInvoice` (the REST create, which also checks ahead of its number
 * reservation) and the draft edit (`update_supplier_invoice`'s grn_id, gate finding 3); MCP, bulk, import, recurring and capture
 * creates never set it. A soft-deleted bill brought back by undo becomes live again with its grn_id, so the restore checks too, and a
 * draft edit that changes the supplier keeps a note that must still agree (`assertEditedBillGrn`).
 *
 * The note must also AGREE with the bill (merge-gate finding 1, decided for Hein): its PO is a PO of the bill's supplier, and when the
 * bill names POs (its header `purchase_order_id`, the POs its lines' `po_item_id`s belong to, and on a restore its link rows) the note's
 * PO is one of them. A note's PO and that PO's supplier do not move while the note is live (app_user cannot UPDATE a note, and the PO
 * tools refuse a supplier change on a PO with a live receipt), so they are read after the hold.
 *
 * `lock: true` (inside the writing transaction): the note is held `FOR SHARE` (migration 1021's `goods_received_note_hold`, a
 * definer: app_user has no UPDATE on the notes, which a row lock needs) and judged UNDER that lock. The cancel takes the note
 * `FOR UPDATE` and then looks for live bills, so exactly one wins: the bill waits for a running cancel and then reads `cancelled`, or the
 * cancel waits for the bill and then finds it (grn_on_bill). Lock order: after whatever PO rows the create holds (`assertBillPoLinks`,
 * FOR KEY SHARE; its bill row is new) and after the bill row (restore); the cancel holds PO -> po_items -> note and never a bill
 * row, so no cycle. Bounded like every PO lock (5 s, typed retryable).
 */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import { RowLockTimeoutError, withRowLockBudget } from '../core/rowLockBudget';
import { SoftDeleteRefusalError } from '../core/softDeleteErrors';

export class SupplierInvoiceGrnRefusal extends Error {
  readonly code = 'SUPPLIER_INVOICE_GRN_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'SupplierInvoiceGrnRefusal';
  }
}

type Db = typeof sql | TxSql;

interface NoteFacts { status: string; poId: string; supplierId: string | null }

/** The note's status (held FOR SHARE when `lock`), its PO and that PO's supplier; null when it is not a note of the session company. */
async function noteFacts(db: Db, companyId: string, grnId: string, lock: boolean): Promise<NoteFacts | null> {
  if (lock) {
    const held = await withRowLockBudget(async () => (await db`SELECT public.goods_received_note_hold(${grnId}::uuid) AS status`) as DbRow[],
      () => new RowLockTimeoutError(`Goods received note ${grnId}`));
    if (held[0]?.status == null) return null;
  }
  const rows = (await db`
    SELECT g.status, g.purchase_order_id::text AS po_id, po.supplier_id::text AS supplier_id
      FROM goods_received_notes g LEFT JOIN purchase_orders po ON po.id = g.purchase_order_id AND po.company_id = g.company_id
     WHERE g.id = ${grnId}::uuid AND g.company_id = ${companyId}::uuid
  `) as DbRow[];
  const row = rows[0];
  return row ? { status: String(row.status), poId: String(row.po_id).toLowerCase(), supplierId: row.supplier_id == null ? null : String(row.supplier_id).toLowerCase() } : null;
}

/** Why the note does not agree with the bill (its supplier, the POs it names), or null when it does. */
function disagreement(note: NoteFacts, supplierId: string | null, namedPos: ReadonlySet<string>): string | null {
  if (supplierId === null || note.supplierId !== supplierId.toLowerCase()) return 'is on another supplier\'s purchase order';
  if (namedPos.size > 0 && !namedPos.has(note.poId)) return 'is on a purchase order the bill does not name';
  return null;
}

/**
 * The POs a bill names: its header PO and the POs its lines' PO lines belong to, lower case, each only when it is a purchase_orders row
 * of this company (review L2: a header holding a legacy supplier_purchase_orders id or any other id names no PO; the column has no FK).
 */
async function namedPurchaseOrders(db: Db, companyId: string, purchaseOrderId: unknown, poItemIds: readonly unknown[]): Promise<Set<string>> {
  const named = new Set<string>();
  if (typeof purchaseOrderId === 'string' && UUID_RE.test(purchaseOrderId)) {
    const header = (await db`SELECT id::text AS id FROM purchase_orders WHERE id = ${purchaseOrderId}::uuid AND company_id = ${companyId}::uuid`) as DbRow[];
    if (header[0]) named.add(String(header[0].id).toLowerCase());
  }
  const items = poItemIds.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v));
  if (items.length > 0) {
    const rows = (await db`
      SELECT DISTINCT pi.purchase_order_id::text AS po FROM po_items pi
        JOIN purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${companyId}::uuid
       WHERE pi.id = ANY(${items}::uuid[])
    `) as DbRow[];
    for (const r of rows) named.add(String(r.po).toLowerCase());
  }
  return named;
}

/** What a new bill carries that its note must agree with. */
export interface BillGrnContext { supplierId: string; purchaseOrderId?: unknown; items?: ReadonlyArray<{ poItemId?: unknown }> }

/**
 * The grn_id a new bill may carry: null for none, else the note's id, lower case. Refused (`SupplierInvoiceGrnRefusal`, 400 on the
 * route): not a valid id, not a goods received note of this company, a cancelled note, a note on another supplier's PO, a note on a PO
 * other than the ones the bill names (`bill`: its supplier, header PO and lines).
 */
export async function assertBillGrn(
  companyId: string, grnId: unknown, bill: BillGrnContext, opts: { db?: Db; lock?: boolean } = {},
): Promise<string | null> {
  if (grnId === undefined || grnId === null || grnId === '') return null;
  if (typeof grnId !== 'string' || !UUID_RE.test(grnId)) throw new SupplierInvoiceGrnRefusal('The bill names a goods received note that is not a valid id');
  const id = grnId.toLowerCase();
  const db = opts.db ?? sql;
  const note = await noteFacts(db, companyId, id, opts.lock === true);
  if (note === null) throw new SupplierInvoiceGrnRefusal('The bill names a goods received note that is not one of this company\'s');
  if (note.status === 'cancelled') throw new SupplierInvoiceGrnRefusal('The bill names a goods received note that is cancelled; choose a live one or none');
  const named = await namedPurchaseOrders(db, companyId, bill.purchaseOrderId, (bill.items ?? []).map((i) => i.poItemId));
  const why = disagreement(note, bill.supplierId, named);
  if (why) throw new SupplierInvoiceGrnRefusal(`The bill names a goods received note that ${why}; choose a note of this supplier's purchase order${named.size > 0 ? ' the bill names' : ''}, or none`);
  return id;
}

/**
 * Before a soft-deleted bill is restored (undo): a bill that names a note of this company that is now cancelled stays deleted
 * (`SoftDeleteRefusalError`, 400), since a cancel only ever passed it because it was deleted; so does one whose note does not agree
 * with it (another supplier's PO, or a PO other than the ones it names: its header, its lines' PO lines, its link rows). The bill row
 * FIRST (`FOR UPDATE`, the row the restore then updates), then the note FOR SHARE: bill -> note, as a draft edit takes bill -> PO and
 * the cancel PO -> note, so no cycle; a cancel cannot slip between this check and the restore. A grn_id naming no note of this company
 * is left as it was (the cancel never sees it).
 */
/** The POs a stored bill names: its header PO, its lines' PO lines' POs and its link rows (this company's), lower case. */
async function storedBillNamedPos(db: Db, companyId: string, billId: string, headerPo: unknown): Promise<Set<string>> {
  const lines = (await db`SELECT po_item_id::text AS po_item_id FROM supplier_invoice_items WHERE supplier_invoice_id = ${billId}::uuid AND po_item_id IS NOT NULL`) as DbRow[];
  const named = await namedPurchaseOrders(db, companyId, headerPo, lines.map((l) => l.po_item_id));
  const links = (await db`
    SELECT purchase_order_id::text AS po FROM purchase_order_bill_links WHERE company_id = ${companyId}::uuid AND supplier_invoice_id = ${billId}::uuid
  `) as DbRow[];
  for (const l of links) named.add(String(l.po).toLowerCase());
  return named;
}

/**
 * A draft edit (update_supplier_invoice) that changes the bill's supplier or its grn_id: the note it will carry (`grnId`, lower
 * case; not null) must be this company's, live, and agree with the bill as it will stand (the new `supplierId`, the POs it names:
 * its header, its lines' PO lines and its link rows, none of which this edit changes). Refused (`SupplierInvoiceGrnRefusal`) with the
 * exit: in the same edit, grn_id null takes the note off, or the id of a live note that agrees. The edit's plan calls it unlocked
 * (before any write, on the locked bill row); its apply calls it again with `lock: true` AFTER the links refresh (bill -> PO -> note,
 * the create's order), so a cancel cannot slip between the check and the commit.
 */
export async function assertEditedBillGrn(
  companyId: string, billId: string, grnId: string, supplierId: string, opts: { db?: Db; lock?: boolean } = {},
): Promise<void> {
  const db = opts.db ?? sql;
  const exit = 'send grn_id: null in this edit to take the note off the bill, or the id of a live goods received note on a purchase order of the bill\'s supplier that the bill names';
  if (!UUID_RE.test(grnId)) throw new SupplierInvoiceGrnRefusal(`The bill would name a goods received note that is not a valid id; ${exit}`);
  const note = await noteFacts(db, companyId, grnId.toLowerCase(), opts.lock === true);
  if (note === null) throw new SupplierInvoiceGrnRefusal(`The bill would name a goods received note that is not one of this company's; ${exit}`);
  if (note.status === 'cancelled') throw new SupplierInvoiceGrnRefusal(`The bill would name a goods received note that is cancelled; ${exit}`);
  const bill = ((await db`SELECT purchase_order_id::text AS purchase_order_id FROM supplier_invoices WHERE id = ${billId}::uuid AND company_id = ${companyId}::uuid`) as DbRow[])[0];
  const why = disagreement(note, supplierId, await storedBillNamedPos(db, companyId, billId, bill?.purchase_order_id));
  if (why) throw new SupplierInvoiceGrnRefusal(`The bill's goods received note ${why} after this edit; ${exit}`);
}

/**
 * unlink_bill_from_purchase_order (gate finding 3): the refusal text when the bill carries a note (of this company) on `poId` and would
 * still name another PO after the unlink (its header, its lines' POs, its link rows, less `poId`), else null. Unlinking the last PO the
 * bill names stays allowed: the note's PO is still of the bill's supplier, and a bill that names no PO may carry any such note. A cancelled
 * or deleted bill is never refused (unlinking it is clean-up). Read
 * after the caller's PO and bill locks, before any write.
 */
export async function unlinkNoteRefusal(companyId: string, billId: string, poId: string): Promise<string | null> {
  const row = ((await sql`
    SELECT si.invoice_number, si.purchase_order_id::text AS header, g.grn_number, g.purchase_order_id::text AS note_po
      FROM supplier_invoices si JOIN goods_received_notes g ON g.id = si.grn_id AND g.company_id = si.company_id
     WHERE si.id = ${billId}::uuid AND si.company_id = ${companyId}::uuid
       -- A cancelled or deleted bill is clean-up (the unlink's own rule, review L1): its note frees no claim and blocks nothing.
       AND si.deleted_at IS NULL AND si.status IS DISTINCT FROM 'cancelled'
  `) as DbRow[])[0];
  if (!row || String(row.note_po).toLowerCase() !== poId.toLowerCase()) return null;
  const named = await storedBillNamedPos(sql, companyId, billId, row.header);
  named.delete(poId.toLowerCase());
  if (named.size === 0) return null;
  const others = (await sql`
    SELECT id::text AS id, po_number FROM purchase_orders WHERE company_id = ${companyId}::uuid AND id = ANY(${[...named]}::uuid[]) ORDER BY po_number, id
  `) as DbRow[];
  const names = [...named].sort().map((id) => String(others.find((o) => String(o.id).toLowerCase() === id)?.po_number ?? id));
  const list = names.join(', ');
  return `Bill ${String(row.invoice_number)} carries goods received note ${String(row.grn_number)} of this purchase order and would still name purchase order${names.length === 1 ? '' : 's'} ${list} after this unlink, `
    + `so its note would be on a purchase order it does not name (note_po_not_named). Unlink ${list} from the bill first, or cancel the bill (cancel_supplier_invoice). Nothing was written`;
}

export async function assertBillRestorableGrn(companyId: string, billId: string): Promise<void> {
  const bill = (await withRowLockBudget(async () => (await sql`
    SELECT grn_id::text AS grn_id, supplier_id::text AS supplier_id, purchase_order_id::text AS purchase_order_id FROM supplier_invoices
     WHERE id = ${billId}::uuid AND company_id = ${companyId}::uuid AND deleted_at IS NOT NULL
       FOR UPDATE
  `) as DbRow[], () => new RowLockTimeoutError(`Supplier invoice ${billId}`)))[0];
  if (!bill || bill.grn_id == null) return;
  const note = await noteFacts(sql, companyId, String(bill.grn_id), true);
  if (note === null) return;
  if (note.status === 'cancelled') {
    throw new SoftDeleteRefusalError('This bill names a goods received note that has since been cancelled, so it cannot be restored; enter the bill again as a new one (naming a live note, or none)');
  }
  const named = await storedBillNamedPos(sql, companyId, billId, bill.purchase_order_id);
  const why = disagreement(note, bill.supplier_id == null ? null : String(bill.supplier_id), named);
  if (why) throw new SoftDeleteRefusalError(`This bill names a goods received note that ${why}, so it cannot be restored; enter the bill again as a new one (naming a note of its supplier's purchase order, or none)`);
}
