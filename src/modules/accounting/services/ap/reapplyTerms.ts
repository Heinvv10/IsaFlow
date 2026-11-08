/**
 * Re-apply payment terms to open supplier bills (payment-terms programme PR 3; Hein, 2026-11-05).
 *
 * Preview first, then write exactly what was confirmed:
 *   - open bills only: draft, pending approval, approved or part-paid, not deleted, something still owing (a disputed
 *     bill is left alone: its date is part of the dispute);
 *   - the new date is the SUPPLIER's own terms (`shared/paymentTerms.dueDateFromTerms`), never the company default: a
 *     supplier whose terms are not set is skipped and listed, so a default nobody chose never moves a real bill;
 *   - a bill whose date came from terms or before sources were recorded (`terms`, `legacy`) is pre-ticked; one set by
 *     hand or by its document (`manual`, `document`) is listed unticked (since migration 963 no supplier can hold the old
 *     stamped default (30, NULL / 'days'): it is not set, or an explicit 30 days from invoice);
 *   - bills whose date would not change are counted, not listed.
 * Apply takes the pairs the person confirmed, each with the due date and source the preview showed. Each bill is locked
 * in id order (the order every other bill locker uses), re-read, and written only when it is still open, its due date
 * and source are still the ones previewed (a date set by hand since then is never overwritten unseen), its supplier's terms (as read then: the supplier row
 * is not locked, so an edit committing during the apply is seen by the next preview, not this write) give exactly the
 * confirmed date, and the date differs; anything else is skipped with a reason. A written bill's source becomes `terms`. Every
 * change is recorded in the entity history by migration 962's capture (who, when, old and new date and source).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { dueDateFromTerms, readTerms } from '../shared/paymentTerms';
import type { DueDateSource } from '../shared/dueDateSource';
import {
  REAPPLY_EPS as EPS, REAPPLY_MAX, REAPPLY_UUID as UUID, ReapplyRefusal, fmtTerms, parseReapplyItems, previewTick,
  reapplyDecision, sourceOfRow, type ReapplyResult,
} from '../shared/reapplyTermsShared';
import { lockSupplierInvoiceForUpdate } from './supplierInvoiceLock';

// Shared with the AR twin (ar/reapplyTerms.ts); re-exported so the AP callers' imports stay as they were.
export { REAPPLY_MAX, ReapplyRefusal, parseReapplyItems };
export type { ReapplyItem, ReapplyResult, ReapplySkipReason } from '../shared/reapplyTermsShared';

export const REAPPLY_OPEN_STATUSES = ['draft', 'pending_approval', 'approved', 'partially_paid'] as const;

export interface ReapplyRow {
  id: string;
  invoiceNumber: string;
  supplierId: string;
  supplierName: string;
  status: string;
  invoiceDate: string;
  balance: number;
  currentDueDate: string | null;
  currentSource: DueDateSource;
  newDueDate: string;
  terms: string;
  /** Ticked by default: the date came from terms (or before sources were recorded) and the terms look chosen. */
  preselected: boolean;
  /** Why it is not ticked, when it is not. */
  note: string | null;
}

export interface ReapplySkippedSupplier { supplierId: string; supplierName: string; openBills: number; balance: number }

export interface ReapplyPreview {
  rows: ReapplyRow[];
  /** Open bills of suppliers with terms whose due date already matches. */
  unchanged: number;
  /** Suppliers with open bills and no terms set: nothing of theirs is re-dated. */
  skippedSuppliers: ReapplySkippedSupplier[];
  /** True when more than REAPPLY_MAX bills would be listed; narrow by supplier. */
  truncated: boolean;
}

export async function previewReapplyTerms(companyId: string, opts: { supplierId?: string } = {}): Promise<ReapplyPreview> {
  if (opts.supplierId !== undefined && !UUID.test(opts.supplierId)) throw new ReapplyRefusal('supplierId must be a supplier id');
  const rows = (await sql`
    SELECT si.id, si.invoice_number, si.supplier_id, s.name AS supplier_name, si.status,
           to_char(si.invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(si.due_date, 'YYYY-MM-DD') AS due_date,
           si.due_date_source, (si.total_amount - COALESCE(si.amount_paid, 0))::FLOAT8 AS balance,
           s.payment_terms, s.payment_terms_type
    FROM supplier_invoices si
    JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = si.company_id
    WHERE si.company_id = ${companyId}::UUID AND si.deleted_at IS NULL
      AND si.status = ANY(${[...REAPPLY_OPEN_STATUSES]}::TEXT[])
      AND si.total_amount - COALESCE(si.amount_paid, 0) > ${EPS}
      AND (${opts.supplierId ?? null}::UUID IS NULL OR si.supplier_id = ${opts.supplierId ?? null}::UUID)
    ORDER BY s.name, si.supplier_id, si.invoice_date, si.id
  `) as DbRow[];

  const out: ReapplyRow[] = [];
  const skipped = new Map<string, ReapplySkippedSupplier>();
  let unchanged = 0;
  for (const r of rows) {
    const days = r.payment_terms == null ? null : Number(r.payment_terms);
    const type = r.payment_terms_type == null ? null : String(r.payment_terms_type);
    const balance = Number(r.balance);
    const newDue = readTerms(days, type) ? dueDateFromTerms(String(r.invoice_date), days, type) : null;
    if (newDue === null) {
      const s = skipped.get(String(r.supplier_id))
        ?? { supplierId: String(r.supplier_id), supplierName: String(r.supplier_name), openBills: 0, balance: 0 };
      s.openBills += 1;
      s.balance = Math.round((s.balance + balance) * 100) / 100;
      skipped.set(s.supplierId, s);
      continue;
    }
    const current = r.due_date == null ? null : String(r.due_date);
    if (current === newDue) { unchanged += 1; continue; }
    const source = sourceOfRow(r.due_date_source);
    out.push({
      id: String(r.id), invoiceNumber: String(r.invoice_number), supplierId: String(r.supplier_id),
      supplierName: String(r.supplier_name), status: String(r.status), invoiceDate: String(r.invoice_date), balance,
      currentDueDate: current, currentSource: source, newDueDate: newDue, terms: fmtTerms(days, type),
      ...previewTick(source),
    });
  }
  return {
    rows: out.slice(0, REAPPLY_MAX), unchanged, truncated: out.length > REAPPLY_MAX,
    skippedSuppliers: [...skipped.values()],
  };
}

/** Write the confirmed dates. Runs in the request's transaction (withAuth): the row locks hold to its commit. */
export async function applyReapplyTerms(companyId: string, rawItems: unknown): Promise<ReapplyResult> {
  const items = parseReapplyItems(rawItems).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const result: ReapplyResult = { updated: [], skipped: [] };
  for (const item of items) {
    const row = await lockSupplierInvoiceForUpdate(companyId, item.id);
    if (!row || row.deleted_at) { result.skipped.push({ id: item.id, reason: 'not_found' }); continue; }
    const owing = Number(row.total_amount ?? 0) - Number(row.amount_paid ?? 0);
    if (!(REAPPLY_OPEN_STATUSES as readonly string[]).includes(String(row.status)) || owing <= EPS) {
      result.skipped.push({ id: item.id, reason: 'not_open' }); continue;
    }
    // The bill's dates as text and its supplier's terms as they stand now, read after the bill's lock. The supplier row
    // is NOT locked (accepted): an edit of its terms committing between this read and the UPDATE leaves this bill on the
    // terms it was confirmed for, and the next preview lists it again.
    const [d] = (await sql`
      SELECT to_char(si.invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(si.due_date, 'YYYY-MM-DD') AS due_date,
             si.due_date_source, s.payment_terms, s.payment_terms_type
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = si.company_id
      WHERE si.id = ${item.id}::UUID AND si.company_id = ${companyId}::UUID
    `) as DbRow[];
    // A date or source that moved since the preview (an agreed date set by hand, say) is never overwritten unseen;
    // unknown sources read as `legacy`, as the preview does (reapplyDecision).
    const from = d?.due_date == null ? null : String(d.due_date);
    const days = d?.payment_terms == null ? null : Number(d.payment_terms);
    const type = d?.payment_terms_type == null ? null : String(d.payment_terms_type);
    const newDue = d && readTerms(days, type) ? dueDateFromTerms(String(d.invoice_date), days, type) : null;
    const decision = reapplyDecision(item, { dueDate: from, source: sourceOfRow(d?.due_date_source) }, newDue);
    if ('skip' in decision) { result.skipped.push({ id: item.id, reason: decision.skip }); continue; }
    await sql`
      UPDATE supplier_invoices SET due_date = ${decision.write}::DATE, due_date_source = 'terms', updated_at = NOW()
      WHERE id = ${item.id}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
        AND status = ANY(${[...REAPPLY_OPEN_STATUSES]}::TEXT[])
    `;
    result.updated.push({ id: item.id, invoiceNumber: String(row.invoice_number), from, to: decision.write });
  }
  return result;
}
