/**
 * The digest an Approve sends back (PR S): what the invoice shows, as one value. The approval digest
 * (`approval_document_digest`, migration 865/923: parties, number, dates, currency, totals, every line) does not
 * cover what the PDF shows besides: notes, the due date and the billing period. This hashes them together, so a
 * change to any of them after the page read the invoice is refused at approve (409 STALE_VIEW).
 *
 * Every reply that hands the page an invoice carries it (the detail GET, the create, each draft PUT), and the approval
 * computes it under its row lock from the same columns. Each reader selects them as `SHOWN_COLUMNS` names them.
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
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** The shown digest, or '' when the row has no approval digest (then nothing matches it). */
export function shownDigestOf(row: ShownRow): string {
  const approval = row.approval_content_digest;
  if (typeof approval !== 'string' || approval === '') return '';
  const shown = [approval, text(row.notes), text(row.due_date), text(row.billing_period_start), text(row.billing_period_end)];
  return createHash('sha256').update(JSON.stringify(shown)).digest('hex');
}

/** This company's invoice's shown digest, read now ('' when there is no such invoice). */
export async function readShownDigest(q: TxSql, companyId: string, invoiceId: string): Promise<string> {
  const rows = (await q`
    SELECT approval_document_digest(company_id, 'customer_invoice', id) AS approval_content_digest, notes,
           to_char(due_date, 'YYYY-MM-DD') AS due_date,
           to_char(billing_period_start, 'YYYY-MM-DD') AS billing_period_start,
           to_char(billing_period_end, 'YYYY-MM-DD') AS billing_period_end
      FROM customer_invoices WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}
  `) as ShownRow[];
  return rows[0] ? shownDigestOf(rows[0]) : '';
}
