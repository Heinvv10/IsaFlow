/**
 * Re-apply payment terms to open supplier bills (payment-terms programme PR 3; Hein, 2026-11-05).
 *
 * Preview first, then write exactly what was confirmed:
 *   - open bills only: draft, pending approval, approved or part-paid, not deleted, something still owing;
 *   - the new date is the SUPPLIER's own terms (`shared/paymentTerms.dueDateFromTerms`), never the company default: a
 *     supplier whose terms are not set is skipped and listed, so a default nobody chose never moves a real bill;
 *   - a bill whose date came from terms or before sources were recorded (`terms`, `legacy`) is pre-ticked; one set by
 *     hand or by its document (`manual`, `document`) is listed unticked; so is every bill of a supplier still on the old
 *     column default shape (30 with no type, or the legacy 'days'), which may be a stamped default, not real terms;
 *   - bills whose date would not change are counted, not listed.
 * Apply takes the (bill, date) pairs the person confirmed. Each bill is locked in id order (the order every other bill
 * locker uses), re-read, and written only when it is still open, its supplier's terms still give exactly the confirmed
 * date, and the date differs; anything else is skipped with a reason. A written bill's source becomes `terms`. Every
 * change is recorded in the entity history by migration 962's capture (who, when, old and new date and source).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { localDateFromISO } from '@/lib/dateUtils';
import { describePaymentTerms, dueDateFromTerms, readTerms } from '../shared/paymentTerms';
import { isDueDateSource, type DueDateSource } from '../shared/dueDateSource';
import { lockSupplierInvoiceForUpdate } from './supplierInvoiceLock';

export const REAPPLY_OPEN_STATUSES = ['draft', 'pending_approval', 'approved', 'partially_paid'] as const;
/** The most bills one preview lists, and one apply writes. */
export const REAPPLY_MAX = 2000;
const EPS = 0.005;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

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

/**
 * The old column default's shape, (30, NULL) or (30, 'days'): the old createSupplier / createCustomer stamped it on
 * contacts nobody gave terms, so it may not be terms someone chose (PR 1b maps it to not set).
 */
export function looksLikeStampedDefault(days: number | null, type: string | null): boolean {
  return days === 30 && (type === null || type === 'days');
}

const fmtTerms = (days: number | null, type: string | null): string => {
  const t = readTerms(days, type);
  return t ? describePaymentTerms(t.days, t.type) : 'Not set';
};

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
    const source: DueDateSource = isDueDateSource(r.due_date_source) ? r.due_date_source : 'legacy';
    const stamped = looksLikeStampedDefault(days, type);
    const handSet = source === 'manual' || source === 'document';
    out.push({
      id: String(r.id), invoiceNumber: String(r.invoice_number), supplierId: String(r.supplier_id),
      supplierName: String(r.supplier_name), status: String(r.status), invoiceDate: String(r.invoice_date), balance,
      currentDueDate: current, currentSource: source, newDueDate: newDue, terms: fmtTerms(days, type),
      preselected: !handSet && !stamped,
      note: handSet
        ? (source === 'manual' ? 'Due date was set by hand' : 'Due date came from the document')
        : stamped ? 'Supplier terms may be the old default (30 days): confirm them on the supplier first' : null,
    });
  }
  return {
    rows: out.slice(0, REAPPLY_MAX), unchanged, truncated: out.length > REAPPLY_MAX,
    skippedSuppliers: [...skipped.values()],
  };
}

export class ReapplyRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'ReapplyRefusal'; }
}

export type ReapplySkipReason = 'not_found' | 'not_open' | 'terms_not_set' | 'terms_changed' | 'already_dated';
export interface ReapplyResult {
  updated: { id: string; invoiceNumber: string; from: string | null; to: string }[];
  skipped: { id: string; reason: ReapplySkipReason }[];
}

/** Parse the confirmed (bill, date) pairs: every one a bill id and a real date, no bill twice, at most REAPPLY_MAX. */
export function parseReapplyItems(raw: unknown): { id: string; dueDate: string }[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ReapplyRefusal('items must list at least one bill and its new due date');
  if (raw.length > REAPPLY_MAX) throw new ReapplyRefusal(`At most ${REAPPLY_MAX} bills at a time`);
  const seen = new Set<string>();
  return raw.map((it, i) => {
    const o = (it ?? {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.toLowerCase() : '';
    const dueDate = typeof o.dueDate === 'string' ? o.dueDate : '';
    if (!UUID.test(id)) throw new ReapplyRefusal(`items[${i}].id must be a bill id`);
    if (!ISO.test(dueDate) || localDateFromISO(dueDate) === null) throw new ReapplyRefusal(`items[${i}].dueDate must be a real date as YYYY-MM-DD`);
    if (seen.has(id)) throw new ReapplyRefusal(`items[${i}]: bill ${id} is listed twice`);
    seen.add(id);
    return { id, dueDate };
  });
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
             s.payment_terms, s.payment_terms_type
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = si.company_id
      WHERE si.id = ${item.id}::UUID AND si.company_id = ${companyId}::UUID
    `) as DbRow[];
    const days = d?.payment_terms == null ? null : Number(d.payment_terms);
    const type = d?.payment_terms_type == null ? null : String(d.payment_terms_type);
    const newDue = d && readTerms(days, type) ? dueDateFromTerms(String(d.invoice_date), days, type) : null;
    if (newDue === null) { result.skipped.push({ id: item.id, reason: 'terms_not_set' }); continue; }
    if (newDue !== item.dueDate) { result.skipped.push({ id: item.id, reason: 'terms_changed' }); continue; }
    const from = d?.due_date == null ? null : String(d.due_date);
    if (from === newDue) { result.skipped.push({ id: item.id, reason: 'already_dated' }); continue; }
    await sql`
      UPDATE supplier_invoices SET due_date = ${newDue}::DATE, due_date_source = 'terms', updated_at = NOW()
      WHERE id = ${item.id}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
        AND status = ANY(${[...REAPPLY_OPEN_STATUSES]}::TEXT[])
    `;
    result.updated.push({ id: item.id, invoiceNumber: String(row.invoice_number), from, to: newDue });
  }
  return result;
}
