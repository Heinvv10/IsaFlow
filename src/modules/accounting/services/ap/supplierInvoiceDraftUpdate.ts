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
import { sql, withTransaction } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import type { SupplierInvoiceItemInput } from '../../types/ap.types';
import { DEFAULT_SUPPLIER_TAX_RATE } from '../../constants/supplierInvoiceDefaults';
import { computeFingerprint } from '../capture/captureDeduplicationService';
import { supplierBelongsToCompany } from '../core/contactDirectoryService';
import { accountsBelongToCompany } from '../gl/chartOfAccountsService';
import { lockSupplierInvoiceForUpdate } from './supplierInvoiceLock';
import {
  assertSupplierInvoiceLines,
  computeSupplierInvoiceTotals,
  defaultVatClassification,
  type SupplierInvoiceTotals,
} from './supplierInvoiceTotals';

/** A refusal whose message is safe to show the caller. Raised before any write. */
export class SupplierInvoiceDraftUpdateRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplierInvoiceDraftUpdateRefusal';
  }
}

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
  items?: SupplierInvoiceItemInput[];
}

export interface SupplierInvoiceDraftUpdatePlan {
  invoiceId: string;
  supplierId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  paymentTerms: string | null;
  reference: string | null;
  notes: string | null;
  exchangeRate: number;
  totalBefore: number;
  /** The recomputed lines and totals, or null when the lines are untouched. */
  lines: (SupplierInvoiceTotals & { taxRate: number }) | null;
  /** Patch field names whose value differs from the stored one. */
  changed: string[];
}

const EPS = 0.005;

export async function lockAndPlanSupplierInvoiceDraftUpdate(
  companyId: string,
  invoiceId: string,
  patch: SupplierInvoiceDraftPatch,
): Promise<SupplierInvoiceDraftUpdatePlan> {
  const row = await lockSupplierInvoiceForUpdate(companyId, invoiceId);
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
  const dueDate = patch.dueDate ?? (row.due_date ? fmtDate(row.due_date) : null);
  if (dueDate && dueDate < invoiceDate) {
    throw new SupplierInvoiceDraftUpdateRefusal(
      `due_date ${dueDate} is before invoice_date ${invoiceDate}.`,
    );
  }

  let lines: SupplierInvoiceDraftUpdatePlan['lines'] = null;
  if (patch.items) {
    lines = await planLines(companyId, invoiceId, number, patch.items,
      patch.taxRate ?? Number(row.tax_rate ?? DEFAULT_SUPPLIER_TAX_RATE));
  }

  const totalBefore = Number(row.total_amount);
  const totalChanges = lines !== null && Math.abs(lines.totalAmount - totalBefore) > EPS;
  if (totalChanges || supplierId !== String(row.supplier_id)) {
    await refuseIfSettlementPlanned(companyId, invoiceId, number);
  }

  const stored: Record<string, unknown> = {
    supplierId: String(row.supplier_id),
    invoiceNumber: number,
    invoiceDate: fmtDate(row.invoice_date),
    dueDate: row.due_date ? fmtDate(row.due_date) : null,
    paymentTerms: row.payment_terms ?? null,
    reference: row.reference ?? null,
    notes: row.notes ?? null,
  };
  const changed = Object.keys(stored).filter((k) => {
    const next = patch[k as keyof SupplierInvoiceDraftPatch];
    return next !== undefined && next !== stored[k];
  });
  if (lines) changed.push('lines');

  return {
    invoiceId,
    supplierId,
    invoiceNumber: patch.invoiceNumber ?? number,
    invoiceDate,
    dueDate,
    paymentTerms: patch.paymentTerms ?? (row.payment_terms ?? null),
    reference: patch.reference ?? (row.reference ?? null),
    notes: patch.notes ?? (row.notes ?? null),
    exchangeRate: Number(row.exchange_rate ?? 1) || 1,
    totalBefore,
    lines,
    changed,
  };
}

/**
 * Validate the replacement lines and refuse when the stored lines carry what
 * the replacement cannot express — a purchase-order line link, a project or
 * cost centre, or a VAT classification other than the rate's default (an
 * exempt 0% line would silently become zero-rated). Dropping those is data loss.
 */
async function planLines(
  companyId: string,
  invoiceId: string,
  number: string,
  items: SupplierInvoiceItemInput[],
  taxRate: number,
): Promise<SupplierInvoiceTotals & { taxRate: number }> {
  try {
    assertSupplierInvoiceLines(items, false);
  } catch (err) {
    throw new SupplierInvoiceDraftUpdateRefusal((err as Error).message);
  }
  const accountIds = items.map((i) => i.glAccountId).filter((id): id is string => Boolean(id));
  if (!(await accountsBelongToCompany(companyId, accountIds))) {
    throw new SupplierInvoiceDraftUpdateRefusal(
      'One or more lines[].gl_account_id values are not GL accounts in your company.',
    );
  }
  const kept = (await sql`
    SELECT description, po_item_id, project_id, cost_center_id, vat_classification, tax_rate
    FROM supplier_invoice_items
    WHERE supplier_invoice_id = ${invoiceId}::UUID
    ORDER BY created_at`) as DbRow[];
  const lost = kept.find((l) => l.po_item_id || l.project_id || l.cost_center_id
    || (l.vat_classification
        && l.vat_classification !== defaultVatClassification(Number(l.tax_rate ?? 0))));
  if (lost) {
    throw new SupplierInvoiceDraftUpdateRefusal(
      `Supplier invoice ${number}'s line "${String(lost.description)}" carries a purchase-order link, `
      + 'project, cost centre or VAT classification that replacing the lines would drop. '
      + 'Edit it in the app instead, or cancel and re-enter it.',
    );
  }
  return { ...computeSupplierInvoiceTotals(items, taxRate, false), taxRate };
}

/**
 * A live payment allocation or credit note already names this bill and its
 * amount. Changing the total or the supplier under it would leave that
 * settlement pointing at a different debt.
 */
async function refuseIfSettlementPlanned(companyId: string, invoiceId: string, number: string): Promise<void> {
  const refs = (await sql`
    SELECT 'payment' AS kind, sp.payment_number AS ref, sp.status
    FROM payment_allocations pa
    JOIN supplier_payments sp ON sp.id = pa.payment_id
    WHERE pa.invoice_id = ${invoiceId}::UUID AND sp.company_id = ${companyId}::UUID
      AND sp.status <> 'cancelled'
    UNION ALL
    SELECT 'credit note', cn.credit_note_number, cn.status
    FROM credit_notes cn
    WHERE cn.supplier_invoice_id = ${invoiceId}::UUID AND cn.company_id = ${companyId}::UUID
      AND cn.status <> 'cancelled'
    LIMIT 1`) as DbRow[];
  if (refs[0]) {
    throw new SupplierInvoiceDraftUpdateRefusal(
      `Supplier invoice ${number} is named on ${String(refs[0].status)} ${String(refs[0].kind)} `
      + `${String(refs[0].ref)}, so its total and supplier cannot change. Remove it from that `
      + `${String(refs[0].kind)} first.`,
    );
  }
}

/** Write the plan. Refuses nothing — call it with no catch. */
export async function applySupplierInvoiceDraftUpdate(
  companyId: string,
  plan: SupplierInvoiceDraftUpdatePlan,
): Promise<void> {
  if (plan.changed.length === 0) return;
  const totals = plan.lines;
  const totalAmount = totals ? totals.totalAmount : plan.totalBefore;
  const [vatRow] = (await sql`
    SELECT vat_number FROM suppliers
    WHERE id = ${plan.supplierId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  const fingerprint = computeFingerprint(
    (vatRow?.vat_number as string | null) ?? null, plan.invoiceNumber, totalAmount,
  );

  await withTransaction(async (tx) => {
    await tx`
      UPDATE supplier_invoices SET
        supplier_id = ${plan.supplierId}::UUID,
        invoice_number = ${plan.invoiceNumber},
        invoice_date = ${plan.invoiceDate}::DATE,
        due_date = ${plan.dueDate}::DATE,
        payment_terms = ${plan.paymentTerms},
        reference = ${plan.reference},
        notes = ${plan.notes},
        subtotal = COALESCE(${totals?.subtotal ?? null}::NUMERIC, subtotal),
        tax_rate = COALESCE(${totals?.taxRate ?? null}::NUMERIC, tax_rate),
        tax_amount = COALESCE(${totals?.totalTax ?? null}::NUMERIC, tax_amount),
        total_amount = ${totalAmount},
        functional_total = ${Math.round(totalAmount * plan.exchangeRate * 100) / 100},
        duplicate_fingerprint = ${fingerprint},
        updated_at = NOW()
      WHERE id = ${plan.invoiceId}::UUID AND company_id = ${companyId}::UUID AND status = 'draft'`;
    if (!totals) return;
    await tx`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id = ${plan.invoiceId}::UUID`;
    for (const item of totals.items) {
      await tx`
        INSERT INTO supplier_invoice_items (
          supplier_invoice_id, description, quantity, unit_price, tax_rate,
          tax_amount, line_total, gl_account_id, vat_classification
        ) VALUES (
          ${plan.invoiceId}::UUID, ${item.description}, ${item.quantity}, ${item.unitPrice},
          ${item.taxRate}, ${item.taxAmount}, ${item.lineTotal}, ${item.glAccountId ?? null}::UUID,
          ${defaultVatClassification(item.taxRate)}
        )`;
    }
  });
}
