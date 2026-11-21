/**
 * The draft edit's goods received note and stored match (update_supplier_invoice; docs/design/mcp-goods-received.md "A bill's GRN").
 *
 * Plan (`planDraftGrn`, before any write, on the locked bill row): the note the bill keeps or is given must agree with it as it will
 * stand (gate finding 3). Only the supplier or the note itself can move that in this edit: the header PO is not editable, and lines that
 * carry a PO line are never replaced (planLines refuses). A refusal is a `SupplierInvoiceDraftUpdateRefusal` naming the exit.
 *
 * Apply (`applyDraftGrn`, inside the edit's transaction, after the links refresh): the note is held FOR SHARE to the commit and judged
 * again (bill -> PO -> note, as the create), so a cancel cannot slip between plan and commit; then the stored three-way match is
 * re-judged when the note OR the supplier changed (round 3 finding 1, review L4: the tolerances are the supplier's coding rules),
 * with `resetMatchState` (performThreeWayMatch when the bill names a PO, else unmatched).
 */
import type { DbRow, TxSql } from '@/lib/neon';
import { SupplierInvoiceGrnRefusal, assertEditedBillGrn } from './billGoodsReceivedLink';
import { resetMatchState } from './purchaseOrderUnlinkClear';
import { SupplierInvoiceDraftUpdateRefusal } from './supplierInvoiceDraftUpdateGuards';

export interface DraftGrnPlan {
  /** The goods received note the bill carries after the edit (lower case), or null. */
  grnId: string | null;
  /** The note must be held and judged again in the apply (the supplier or the note changes and one stays). */
  recheckGrn: boolean;
  /** The edit changes or clears the note. */
  grnChanges: boolean;
  /** The note or the supplier changes: the stored three-way match is re-judged in the apply. */
  rejudgeMatch: boolean;
}

export async function planDraftGrn(
  companyId: string, invoiceId: string, number: string, row: DbRow, patchGrnId: string | null | undefined,
  supplierId: string, supplierChanges: boolean,
): Promise<DraftGrnPlan> {
  const storedGrn = row.grn_id ? String(row.grn_id).toLowerCase() : null;
  const grnId = patchGrnId === undefined ? storedGrn : patchGrnId === null ? null : patchGrnId.toLowerCase();
  const grnChanges = grnId !== storedGrn;
  const recheckGrn = grnId !== null && (supplierChanges || grnChanges);
  if (recheckGrn) {
    try {
      await assertEditedBillGrn(companyId, invoiceId, grnId, supplierId);
    } catch (err) {
      if (err instanceof SupplierInvoiceGrnRefusal) throw new SupplierInvoiceDraftUpdateRefusal(`Supplier invoice ${number}: ${err.message}.`);
      throw err;
    }
  }
  return { grnId, recheckGrn, grnChanges, rejudgeMatch: grnChanges || supplierChanges };
}

export async function applyDraftGrn(
  companyId: string, plan: DraftGrnPlan & { invoiceId: string; supplierId: string }, tx: TxSql,
): Promise<void> {
  if (plan.recheckGrn && plan.grnId) await assertEditedBillGrn(companyId, plan.invoiceId, plan.grnId, plan.supplierId, { db: tx, lock: true });
  if (plan.rejudgeMatch) await resetMatchState(companyId, plan.invoiceId);
}
