/**
 * Edit a DRAFT supplier invoice: header fields, and optionally a full
 * replacement of its lines with the totals recomputed.
 *
 * Only a draft. A draft has posted nothing, so changing it moves no ledger
 * figure; anything past draft has (or is about to have) a journal built from
 * these amounts, and the remedy there is cancel_supplier_invoice + re-enter.
 *
 * Split into a PLAN and an APPLY. Every refusal is raised by the plan, from
 * reads on the LOCKED row, before any write — so a caller can return a
 * `SupplierInvoiceDraftUpdateRefusal` as a tool error and call the apply with
 * no catch. A catch around the write could not tell a refusal from a failure
 * part-way through replacing the lines.
 */
import { sql, withSavepoint, withTransaction } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import type { SupplierInvoiceItemInput } from '../../types/ap.types';
import { DEFAULT_SUPPLIER_TAX_RATE } from '../../constants/supplierInvoiceDefaults';
import { computeFingerprint } from '../capture/captureDeduplicationService';
import { supplierBelongsToCompany } from '../core/contactDirectoryService';
import { lockSupplierInvoiceForUpdate } from './supplierInvoiceLock';
import { withContentEditorStamp } from './supplierInvoiceContentEditor';
import { defaultVatClassification, type SupplierInvoiceTotals } from './supplierInvoiceTotals';
import { billEditDueDate } from './draftBillDueDate';
import { refreshAppBillLinks } from './billPurchaseOrderLinks';
import { SupplierInvoiceGrnRefusal, assertEditedBillGrn } from './billGoodsReceivedLink';
import { resetMatchState } from './purchaseOrderUnlinkClear';
import type { DueDateSource } from '../shared/dueDateSource';
import {
  SupplierInvoiceDraftUpdateRefusal,
  planLines,
  refuseIfJournalNamesBill,
  refuseIfNumberTaken,
  refuseIfBillHasPoLinks,
  refuseIfRecordsPinBill,
  refuseIfSettlementPlanned,
  type InheritedDimension,
} from './supplierInvoiceDraftUpdateGuards';

export { SupplierInvoiceDraftUpdateRefusal };

/** Only the fields present are changed. `items` replaces EVERY line. */
export interface SupplierInvoiceDraftPatch {
  supplierId?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  paymentTerms?: string;
  reference?: string;
  notes?: string;
  /** Invoice-level VAT %; only meaningful with `items`, which it defaults. */
  taxRate?: number;
  /** The bill's goods received note: another live note that agrees with the bill, or null to take it off (gate finding 3). */
  grnId?: string | null;
  items?: SupplierInvoiceItemInput[];
}

export interface SupplierInvoiceDraftUpdatePlan {
  invoiceId: string;
  supplierId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  /** Set when this edit re-dated a terms-sourced due date (shared/draftDueDate.ts): the source to store. Null: the apply's own rule. */
  dueDateSource: DueDateSource | null;
  paymentTerms: string | null;
  reference: string | null;
  notes: string | null;
  /** The goods received note the bill carries after the edit (lower case), or null. */
  grnId: string | null;
  /** The note must be held and judged again in the apply, after the links refresh (the supplier or the note changes and one stays). */
  recheckGrn: boolean;
  /** The edit changes or clears the note: the stored three-way match state is re-judged in the apply. */
  grnChanges: boolean;
  totalBefore: number;
  /** The recomputed lines and totals, or null when the lines are untouched or resent unchanged. */
  lines: (SupplierInvoiceTotals & { taxRate: number; inheritedDimensions: InheritedDimension[] }) | null;
  /** Patch field names whose value differs from the stored one. */
  changed: string[];
  /** Supplier, number or total moved, so the duplicate fingerprint must too. */
  refingerprint: boolean;
}

const EPS = 0.005;

/**
 * Whether a caller named the bill's VAT rate: in this edit, or when the bill was written. A bill written with no rate
 * stores the default, so a stored rate that differs from it was named (0 for a supplier that is not a VAT vendor). A named
 * rate turns off taking an item's VAT on the lines, as it does on create: a line with no rate takes the bill's.
 */
export function billRateWasNamed(patchTaxRate: number | undefined, storedTaxRate: number): boolean {
  return patchTaxRate !== undefined || storedTaxRate !== DEFAULT_SUPPLIER_TAX_RATE;
}

export async function lockAndPlanSupplierInvoiceDraftUpdate(
  companyId: string,
  invoiceId: string,
  patch: SupplierInvoiceDraftPatch,
): Promise<SupplierInvoiceDraftUpdatePlan> {
  // Its own savepoint (K-052): a lock timeout ABORTS the transaction, and a
  // caught error does not un-abort it — the registry's RELEASE would then 25P02
  // and the agent would get GENERIC_FAILURE instead of the "retry" wording.
  // The row lock itself survives the RELEASE; the parent inherits it.
  const row = await withSavepoint('usi_bill_lock', () => lockSupplierInvoiceForUpdate(companyId, invoiceId));
  // One reply for absent, foreign and soft-deleted: no existence oracle.
  if (!row || row.deleted_at) throw new SupplierInvoiceDraftUpdateRefusal('Not found');
  const number = String(row.invoice_number);
  const status = String(row.status);

  if (status !== 'draft') {
    throw new SupplierInvoiceDraftUpdateRefusal(
      `Supplier invoice ${number} is ${status}; only a draft can be edited. `
      + (status === 'cancelled'
        ? 'Re-enter it with create_supplier_invoice.'
        : 'Cancel it with cancel_supplier_invoice and re-enter it with create_supplier_invoice.'),
    );
  }
  // Neither should exist on a draft. Editing the amounts under either would
  // leave a journal or an applied amount built from figures the bill no longer has.
  if (row.gl_journal_entry_id) {
    throw new SupplierInvoiceDraftUpdateRefusal(
      `Supplier invoice ${number} is a draft but is linked to a journal. Reconcile it by hand.`,
    );
  }
  if (Number(row.amount_paid ?? 0) > EPS) {
    throw new SupplierInvoiceDraftUpdateRefusal(
      `Supplier invoice ${number} is a draft but has R${Number(row.amount_paid).toFixed(2)} applied to it. `
      + 'Reconcile it by hand.',
    );
  }
  await refuseIfJournalNamesBill(companyId, invoiceId, number, row.is_drc === true);
  if (patch.taxRate !== undefined && !patch.items) {
    throw new SupplierInvoiceDraftUpdateRefusal(
      'tax_rate only defaults the rate of the lines you send; pass lines with it (each stored line already carries its own rate).',
    );
  }

  const supplierId = patch.supplierId ?? String(row.supplier_id);
  if (patch.supplierId && !(await supplierBelongsToCompany(companyId, patch.supplierId))) {
    throw new SupplierInvoiceDraftUpdateRefusal('Not found');
  }

  const invoiceDate = patch.invoiceDate ?? fmtDate(row.invoice_date);
  const storedDueDate = row.due_date ? fmtDate(row.due_date) : null;
  // Payment-terms Part A, as PUT supplier-invoices-detail: a terms-sourced due date follows a moved date or supplier.
  const redated = await billEditDueDate(companyId, {
    supplierId: String(row.supplier_id), invoiceDate: fmtDate(row.invoice_date), dueDate: storedDueDate, dueDateSource: row.due_date_source,
  }, { supplierId: patch.supplierId, invoiceDate: patch.invoiceDate, dueDate: patch.dueDate, paymentTerms: patch.paymentTerms });
  const dueDate = redated.dueDate ?? storedDueDate;
  if (dueDate && dueDate < invoiceDate) {
    throw new SupplierInvoiceDraftUpdateRefusal(
      `due_date ${dueDate} is before invoice_date ${invoiceDate}.`,
    );
  }

  let lines: SupplierInvoiceDraftUpdatePlan['lines'] = null;
  if (patch.items) {
    const storedTaxRate = Number(row.tax_rate ?? DEFAULT_SUPPLIER_TAX_RATE);
    lines = await planLines(companyId, invoiceId, number, patch.items,
      patch.taxRate ?? storedTaxRate, billRateWasNamed(patch.taxRate, storedTaxRate));
  }

  const totalBefore = Number(row.total_amount);
  const totalChanges = lines !== null && Math.abs(lines.totalAmount - totalBefore) > EPS;
  const supplierChanges = supplierId !== String(row.supplier_id);
  if (totalChanges || supplierChanges) {
    await refuseIfSettlementPlanned(companyId, invoiceId, number);
  }
  const invoiceNumber = patch.invoiceNumber ?? number;
  if (supplierChanges || invoiceNumber !== number) {
    await refuseIfNumberTaken(companyId, invoiceId, supplierId, invoiceNumber);
  }
  if (supplierChanges) await refuseIfBillHasPoLinks(companyId, invoiceId, number);
  if (totalChanges || supplierChanges || invoiceNumber !== number) {
    await refuseIfRecordsPinBill(companyId, invoiceId, number, supplierChanges);
  }
  // Gate finding 3: the note the bill keeps (or is given) must agree with it as it will stand. Only the supplier or the note itself can
  // move that here: the header PO is not editable, and lines that carry a PO line are never replaced (planLines refuses).
  const storedGrn = row.grn_id ? String(row.grn_id).toLowerCase() : null;
  const grnId = patch.grnId === undefined ? storedGrn : patch.grnId === null ? null : patch.grnId.toLowerCase();
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

  const stored: Record<string, unknown> = {
    supplierId: String(row.supplier_id),
    invoiceNumber: number,
    invoiceDate: fmtDate(row.invoice_date),
    dueDate: storedDueDate,
    paymentTerms: row.payment_terms ?? null,
    reference: row.reference ?? null,
    notes: row.notes ?? null,
  };
  const changed = Object.keys(stored).filter((k) => {
    const next = patch[k as keyof SupplierInvoiceDraftPatch];
    return next !== undefined && next !== stored[k];
  });
  if (lines) changed.push('lines');
  if (grnChanges) changed.push('grnId');
  // Re-dated by the terms; not twice when the caller also sent that very date (it is already listed as a changed field).
  if (redated.source !== null && dueDate !== storedDueDate && !changed.includes('dueDate')) changed.push('dueDate');

  return {
    invoiceId,
    supplierId,
    invoiceNumber,
    invoiceDate,
    dueDate,
    dueDateSource: redated.source,
    paymentTerms: patch.paymentTerms ?? (row.payment_terms ?? null),
    reference: patch.reference ?? (row.reference ?? null),
    notes: patch.notes ?? (row.notes ?? null),
    grnId,
    recheckGrn,
    grnChanges,
    totalBefore,
    lines,
    changed,
    refingerprint: totalChanges || supplierChanges || invoiceNumber !== number,
  };
}

/**
 * Write the plan. Refuses nothing the plan did not decide (call it with no catch), except a note cancelled between the plan and the
 * apply's hold (`SupplierInvoiceGrnRefusal`, typed; the caller's transaction takes the edit back). `editedBy` becomes the bill's
 * content author when the write moves the approval digest (R-035).
 */
export async function applySupplierInvoiceDraftUpdate(
  companyId: string,
  plan: SupplierInvoiceDraftUpdatePlan,
  editedBy: string,
): Promise<void> {
  if (plan.changed.length === 0) return;
  const totals = plan.lines;
  const totalAmount = totals ? totals.totalAmount : plan.totalBefore;
  let fingerprint: string | null = null;
  if (plan.refingerprint) {
    const [vatRow] = (await sql`
      SELECT vat_number FROM suppliers
      WHERE id = ${plan.supplierId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
    fingerprint = computeFingerprint(
      (vatRow?.vat_number as string | null) ?? null, plan.invoiceNumber, totalAmount,
    );
  }

  await withContentEditorStamp(companyId, plan.invoiceId, editedBy, () => withTransaction(async (tx) => {
    await tx`
      UPDATE supplier_invoices SET
        supplier_id = ${plan.supplierId}::UUID,
        invoice_number = ${plan.invoiceNumber},
        invoice_date = ${plan.invoiceDate}::DATE,
        due_date = ${plan.dueDate}::DATE,
        -- Migration 962: a due date this edit moves is a hand-set one (the SET reads the stored due_date).
        due_date_source = COALESCE(${plan.dueDateSource}, CASE WHEN ${plan.dueDate}::DATE IS DISTINCT FROM due_date AND ${plan.dueDate}::DATE IS NOT NULL
                               THEN 'manual' ELSE due_date_source END),
        payment_terms = ${plan.paymentTerms},
        reference = ${plan.reference},
        notes = ${plan.notes},
        grn_id = ${plan.grnId}::UUID,
        subtotal = COALESCE(${totals?.subtotal ?? null}::NUMERIC, subtotal),
        tax_rate = COALESCE(${totals?.taxRate ?? null}::NUMERIC, tax_rate),
        tax_amount = COALESCE(${totals?.totalTax ?? null}::NUMERIC, tax_amount),
        total_amount = ${totalAmount},
        functional_total = public.fx_functional(${totalAmount}::NUMERIC(15,2), COALESCE(NULLIF(exchange_rate, 0), 1)),
        duplicate_fingerprint = COALESCE(${fingerprint}, duplicate_fingerprint),
        updated_at = NOW()
      WHERE id = ${plan.invoiceId}::UUID AND company_id = ${companyId}::UUID AND status = 'draft'`;
    if (totals) {
      await tx`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id = ${plan.invoiceId}::UUID`;
      // storedLineOrder assumes these lines are inserted in ONE transaction (they tie on created_at) with the planned ids.
      for (const item of totals.items) {
        await tx`
          INSERT INTO supplier_invoice_items (
            id, supplier_invoice_id, description, quantity, unit_price, tax_rate,
            tax_amount, line_total, gl_account_id, vat_classification, cc1_id, cc2_id, bu_id, item_id
          ) VALUES (
            COALESCE(${item.id ?? null}::UUID, gen_random_uuid()), ${plan.invoiceId}::UUID, ${item.description}, ${item.quantity}, ${item.unitPrice},
            ${item.taxRate}, ${item.taxAmount}, ${item.lineTotal}, ${item.glAccountId ?? null}::UUID,
            ${defaultVatClassification(item.taxRate)},
            ${item.cc1Id ?? null}::UUID, ${item.cc2Id ?? null}::UUID, ${item.buId ?? null}::UUID, ${item.itemId ?? null}::UUID
          )`;
      }
    }
    // Migration 1006: the bill's `app` links follow its new subtotal and lines (amounts are recomputed, not edited).
    await refreshAppBillLinks(companyId, plan.invoiceId, editedBy, tx);
    // The note LAST, held FOR SHARE to the commit (bill -> PO -> note, as the create): a cancel of it waits for this edit and then
    // refuses it as on a bill, or this waits for the cancel and refuses the cancelled note (typed; the transaction takes the edit back).
    if (plan.recheckGrn && plan.grnId) await assertEditedBillGrn(companyId, plan.invoiceId, plan.grnId, plan.supplierId, { db: tx, lock: true });
    // The stored match state was judged against the old note (round 3, finding 1): re-judged (performThreeWayMatch, or unmatched).
    if (plan.grnChanges) await resetMatchState(companyId, plan.invoiceId);
  }));
}
