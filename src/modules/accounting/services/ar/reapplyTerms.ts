/**
 * Re-apply payment terms to open customer invoices (payment-terms programme, AR parity with `ap/reapplyTerms`; Hein,
 * 2026-11-05). The same two steps, the same rules, on the customer side:
 *
 * Preview first, then write exactly what was confirmed:
 *   - open invoices only: draft, pending approval, approved, sent, overdue or part-paid, not deleted, something still
 *     owing;
 *   - the new date is the CUSTOMER's own terms (`shared/paymentTerms.dueDateFromTerms`), never the company default: a
 *     customer whose terms are not set is skipped and listed, so a default nobody chose never moves a real invoice;
 *   - an invoice whose date came from terms or before sources were recorded (`terms`, `legacy`) is pre-ticked; one set by
 *     hand or by its document (`manual`, `document`) is listed unticked;
 *   - invoices whose date would not change are counted, not listed.
 * The customer of an invoice is `COALESCE(client_id, customer_id)`: both columns exist and either can carry it.
 *
 * Apply takes the pairs the person confirmed, each with the due date and source the preview showed. Each invoice is
 * locked in id order (customerInvoiceRowLock), re-read, and written only when it is still open, its due date and source
 * are still the ones previewed (a date set by hand since then is never overwritten unseen), its customer's terms (as
 * read then: the customer row is not locked, so an edit committing during the apply is seen by the next preview, not this
 * write) give exactly the confirmed date, and the date differs (shared/reapplyTermsShared.reapplyDecision); anything
 * else is skipped with a reason. A written invoice's source becomes `terms`; migration 962's capture records every change.
 * The due date is outside the approval digest (migration 865), so no approval is staled.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { DueDateSource } from '../shared/dueDateSource';
import {
  REAPPLY_EPS as EPS, REAPPLY_MAX, REAPPLY_UUID as UUID, ReapplyRefusal, contactTermsOf, fmtTerms, newDueFromTerms,
  parseReapplyItems, previewTick, reapplyDecision, sourceOfRow, tallySkipped, type ReapplyResult, type SkippedTally,
} from '../shared/reapplyTermsShared';
import { lockCustomerInvoiceForUpdate } from './customerInvoiceRowLock';

export const AR_REAPPLY_OPEN_STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'overdue', 'partially_paid'] as const;

export interface ArReapplyRow {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  status: string;
  invoiceDate: string;
  /** What is owing, in the invoice's own currency. */
  balance: number;
  currencyCode: string;
  currentDueDate: string | null;
  currentSource: DueDateSource;
  newDueDate: string;
  terms: string;
  /** Ticked by default: the date came from terms (or before sources were recorded). */
  preselected: boolean;
  /** Why it is not ticked, when it is not. */
  note: string | null;
}

/** `balance` is in the company's functional currency (a foreign invoice's owing at its rate). */
export interface ArReapplySkippedCustomer { customerId: string; customerName: string; openInvoices: number; balance: number }

export interface ArReapplyPreview {
  rows: ArReapplyRow[];
  /** Open invoices of customers with terms whose due date already matches. */
  unchanged: number;
  /** Customers with open invoices and no terms set: nothing of theirs is re-dated. */
  skippedCustomers: ArReapplySkippedCustomer[];
  /** True when more than REAPPLY_MAX invoices would be listed; narrow by customer. */
  truncated: boolean;
}

export async function previewReapplyCustomerTerms(companyId: string, opts: { customerId?: string } = {}): Promise<ArReapplyPreview> {
  if (opts.customerId !== undefined && !UUID.test(opts.customerId)) throw new ReapplyRefusal('customerId must be a customer id');
  const rows = (await sql`
    SELECT ci.id, ci.invoice_number, c.id AS customer_id, c.name AS customer_name, ci.status,
           to_char(ci.invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(ci.due_date, 'YYYY-MM-DD') AS due_date,
           ci.due_date_source, (ci.total_amount - COALESCE(ci.amount_paid, 0))::FLOAT8 AS balance,
           public.fx_functional((ci.total_amount - COALESCE(ci.amount_paid, 0))::NUMERIC(15,2), COALESCE(NULLIF(ci.exchange_rate, 0), 1))::FLOAT8 AS functional_balance,
           COALESCE(ci.currency_code, 'ZAR') AS currency_code, c.payment_terms, c.payment_terms_type
    FROM customer_invoices ci
    JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id) AND c.company_id = ci.company_id
    WHERE ci.company_id = ${companyId}::UUID AND ci.deleted_at IS NULL
      AND ci.status = ANY(${[...AR_REAPPLY_OPEN_STATUSES]}::TEXT[])
      AND ci.total_amount - COALESCE(ci.amount_paid, 0) > ${EPS}
      AND (${opts.customerId ?? null}::UUID IS NULL OR c.id = ${opts.customerId ?? null}::UUID)
    ORDER BY c.name, c.id, ci.invoice_date, ci.id
  `) as DbRow[];

  const out: ArReapplyRow[] = [];
  const skipped = new Map<string, SkippedTally>();
  let unchanged = 0;
  for (const r of rows) {
    const { days, type } = contactTermsOf(r);
    const newDue = newDueFromTerms(String(r.invoice_date), days, type);
    if (newDue === null) { tallySkipped(skipped, String(r.customer_id), String(r.customer_name), Number(r.functional_balance)); continue; }
    const current = r.due_date == null ? null : String(r.due_date);
    if (current === newDue) { unchanged += 1; continue; }
    const source = sourceOfRow(r.due_date_source);
    out.push({
      id: String(r.id), invoiceNumber: String(r.invoice_number), customerId: String(r.customer_id),
      customerName: String(r.customer_name), status: String(r.status), invoiceDate: String(r.invoice_date),
      balance: Number(r.balance), currencyCode: String(r.currency_code), currentDueDate: current, currentSource: source,
      newDueDate: newDue, terms: fmtTerms(days, type), ...previewTick(source),
    });
  }
  return {
    rows: out.slice(0, REAPPLY_MAX), unchanged, truncated: out.length > REAPPLY_MAX,
    skippedCustomers: [...skipped.values()].map((s) => ({ customerId: s.id, customerName: s.name, openInvoices: s.count, balance: s.balance })),
  };
}

/** Write the confirmed dates. Runs in the request's transaction (withAuth): the row locks hold to its commit. */
export async function applyReapplyCustomerTerms(companyId: string, rawItems: unknown): Promise<ReapplyResult> {
  const items = parseReapplyItems(rawItems, 'invoice').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const result: ReapplyResult = { updated: [], skipped: [] };
  for (const item of items) {
    const row = await lockCustomerInvoiceForUpdate(companyId, item.id);
    if (!row || row.deleted_at) { result.skipped.push({ id: item.id, reason: 'not_found' }); continue; }
    const owing = Number(row.total_amount ?? 0) - Number(row.amount_paid ?? 0);
    if (!(AR_REAPPLY_OPEN_STATUSES as readonly string[]).includes(String(row.status)) || owing <= EPS) {
      result.skipped.push({ id: item.id, reason: 'not_open' }); continue;
    }
    // The customer's terms as they stand now, read after the invoice's lock. The customer row is NOT locked (accepted):
    // an edit of its terms committing between this read and the UPDATE leaves this invoice on the terms it was
    // confirmed for, and the next preview lists it again.
    const [t] = (await sql`
      SELECT payment_terms, payment_terms_type FROM customers
      WHERE id = ${String(row.customer_id)}::UUID AND company_id = ${companyId}::UUID
    `) as DbRow[];
    const from = row.due_date == null ? null : String(row.due_date);
    const { days, type } = contactTermsOf(t);
    const newDue = t ? newDueFromTerms(String(row.invoice_date), days, type) : null;
    const decision = reapplyDecision(item, { dueDate: from, source: sourceOfRow(row.due_date_source) }, newDue);
    if ('skip' in decision) { result.skipped.push({ id: item.id, reason: decision.skip }); continue; }
    await sql`
      UPDATE customer_invoices SET due_date = ${decision.write}::DATE, due_date_source = 'terms', updated_at = NOW()
      WHERE id = ${item.id}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
        AND status = ANY(${[...AR_REAPPLY_OPEN_STATUSES]}::TEXT[])
    `;
    result.updated.push({ id: item.id, invoiceNumber: String(row.invoice_number), from, to: decision.write });
  }
  return result;
}
