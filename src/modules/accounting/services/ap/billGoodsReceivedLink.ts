/**
 * A bill's goods received note (`supplier_invoices.grn_id`, review M1 of docs/design/mcp-goods-received.md). The column has NO foreign
 * key (migration 201 created it bare; 246b's ADD COLUMN ... REFERENCES was skipped), so nothing in the database ties a bill to a note:
 * a bill could name a cancelled note, another company's note or no note at all, and a bill written while a cancel ran could end on a
 * cancelled note. Writers of the column (census): `createSupplierInvoice` (the REST create, which also checks ahead of its number
 * reservation) and nothing else; MCP, bulk, import, recurring and capture creates never set it, and no update writes it. A
 * soft-deleted bill brought back by undo becomes live again with its grn_id, so the restore checks too.
 *
 * `lock: true` (inside the writing transaction): the note is held `FOR SHARE` (migration 1021's `goods_received_note_hold`, a
 * definer: app_user has no UPDATE on the notes, which a row lock needs) and judged UNDER that lock. The cancel takes the note
 * `FOR UPDATE` and then looks for live bills, so exactly one wins: the bill waits for a running cancel and then reads `cancelled`, or the
 * cancel waits for the bill and then finds it (grn_on_bill). Lock order: after whatever PO rows the create holds (`assertBillPoLinks`,
 * FOR KEY SHARE) and the bill row (restore); the cancel holds 620 -> PO -> po_items -> note and never a bill row, so no cycle. Bounded
 * like every PO lock (5 s, typed retryable).
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

/** The note's status, held FOR SHARE when `lock`; null when it is not a note of the session company. */
async function noteStatus(db: Db, companyId: string, grnId: string, lock: boolean): Promise<string | null> {
  if (lock) {
    const rows = await withRowLockBudget(async () => (await db`SELECT public.goods_received_note_hold(${grnId}::uuid) AS status`) as DbRow[],
      () => new RowLockTimeoutError(`Goods received note ${grnId}`));
    return rows[0]?.status == null ? null : String(rows[0].status);
  }
  const rows = (await db`SELECT status FROM goods_received_notes WHERE id = ${grnId}::uuid AND company_id = ${companyId}::uuid`) as DbRow[];
  return rows[0] ? String(rows[0].status) : null;
}

/**
 * The grn_id a new bill may carry: null for none, else the note's id, lower case. Refused (`SupplierInvoiceGrnRefusal`, 400 on the
 * route): not a valid id, not a goods received note of this company, a cancelled note.
 */
export async function assertBillGrn(companyId: string, grnId: unknown, opts: { db?: Db; lock?: boolean } = {}): Promise<string | null> {
  if (grnId === undefined || grnId === null || grnId === '') return null;
  if (typeof grnId !== 'string' || !UUID_RE.test(grnId)) throw new SupplierInvoiceGrnRefusal('The bill names a goods received note that is not a valid id');
  const id = grnId.toLowerCase();
  const status = await noteStatus(opts.db ?? sql, companyId, id, opts.lock === true);
  if (status === null) throw new SupplierInvoiceGrnRefusal('The bill names a goods received note that is not one of this company\'s');
  if (status === 'cancelled') throw new SupplierInvoiceGrnRefusal('The bill names a goods received note that is cancelled; choose a live one or none');
  return id;
}

/**
 * Before a soft-deleted bill is restored (undo): a bill that names a note of this company that is now cancelled stays deleted
 * (`SoftDeleteRefusalError`, 400), since a cancel only ever passed it because it was deleted. Held FOR SHARE, so a cancel cannot slip
 * between this check and the restore. A grn_id naming no note of this company is left as it was (the cancel never sees it).
 */
export async function assertBillRestorableGrn(companyId: string, billId: string): Promise<void> {
  const bill = ((await sql`
    SELECT grn_id::text AS grn_id FROM supplier_invoices
     WHERE id = ${billId}::uuid AND company_id = ${companyId}::uuid AND deleted_at IS NOT NULL AND grn_id IS NOT NULL
  `) as DbRow[])[0];
  if (!bill) return;
  if (await noteStatus(sql, companyId, String(bill.grn_id), true) === 'cancelled') {
    throw new SoftDeleteRefusalError('This bill names a goods received note that has since been cancelled, so it cannot be restored');
  }
}
