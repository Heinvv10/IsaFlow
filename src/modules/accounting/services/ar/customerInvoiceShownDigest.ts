/**
 * The shown digest (PR S): what the invoice shows, as one value. The approval digest (`approval_document_digest`,
 * migration 865/923: the customer and client ids, number, invoice date, currency, rate, totals, the job id, every line)
 * does not cover what the PDF prints besides from the invoice itself: notes, the due date, the billing period and the
 * job's name. This hashes them together, so a change to any of them after the page read the invoice is refused: at
 * approve, and at a draft PUT that sends the digest it was edited from (409 STALE_VIEW either way).
 *
 * NOT covered: the customer's master data the PDF prints (name, address, VAT number, contact, email, phone), read from
 * the customer record when the PDF is made; nor the payment terms line, which prints a constant ("30 Days":
 * customer_invoices has no payment_terms column).
 *
 * Every reply that hands the page an invoice carries it (the detail GET's `shown_digest`, the create's and each draft
 * PUT's `shownDigest`); the approval and the draft edit compute it under their row lock from the same columns, which
 * each reader selects under the names `ShownRow` gives them.
 */
import { createHash } from 'node:crypto';
import type { TxSql } from '@/lib/neon';

/** The columns each reader selects, under these names (dates as 'YYYY-MM-DD' text, so no Date / string drift). */
export interface ShownRow {
  approval_content_digest?: unknown;
  notes?: unknown;
  due_date?: unknown;
  billing_period_start?: unknown;
  billing_period_end?: unknown;
  /** The invoice's job (projects.name, company-scoped), as the PDF prints it. */
  project_name?: unknown;
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** The shown digest, or '' when the row has no approval digest (then nothing matches it). */
export function shownDigestOf(row: ShownRow): string {
  const approval = row.approval_content_digest;
  if (typeof approval !== 'string' || approval === '') return '';
  const shown = [approval, text(row.notes), text(row.due_date), text(row.billing_period_start), text(row.billing_period_end),
    text(row.project_name)];
  return createHash('sha256').update(JSON.stringify(shown)).digest('hex');
}

/** This company's invoice's shown digest, read now ('' when there is no such invoice). */
export async function readShownDigest(q: TxSql, companyId: string, invoiceId: string): Promise<string> {
  const rows = (await q`
    SELECT approval_document_digest(ci.company_id, 'customer_invoice', ci.id) AS approval_content_digest, ci.notes,
           to_char(ci.due_date, 'YYYY-MM-DD') AS due_date,
           to_char(ci.billing_period_start, 'YYYY-MM-DD') AS billing_period_start,
           to_char(ci.billing_period_end, 'YYYY-MM-DD') AS billing_period_end,
           (SELECT p.name FROM projects p WHERE p.id = ci.project_id AND p.company_id = ci.company_id) AS project_name
      FROM customer_invoices ci WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}
  `) as ShownRow[];
  return rows[0] ? shownDigestOf(rows[0]) : '';
}

/** A draft PUT edited from `expected` (the shown digest its page last had), when the invoice has moved since. */
export async function shownDigestMoved(q: TxSql, companyId: string, invoiceId: string, expected: string | undefined): Promise<boolean> {
  return expected !== undefined && expected !== await readShownDigest(q, companyId, invoiceId);
}
