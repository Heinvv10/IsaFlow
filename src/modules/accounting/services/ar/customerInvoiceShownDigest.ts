/**
 * The shown digest (PR S): what the invoice shows, as one value. The approval digest (`approval_document_digest`,
 * migration 865/923: the customer and client ids, number, invoice date, currency, rate, totals, the job id, every line)
 * does not cover what the PDF prints besides from the invoice itself: notes, the due date, the billing period, the
 * job's name, and the current customer and issuer details. This hashes them together, so a change to any of them after
 * the page read the invoice is refused: at approve, and at a draft PUT that sends the digest it was edited from (409
 * STALE_VIEW either way). The payment terms line is not covered because it prints a constant ("30 Days":
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
  customer_name?: unknown;
  customer_address?: unknown;
  customer_contact?: unknown;
  customer_email?: unknown;
  customer_phone?: unknown;
  customer_vat?: unknown;
  company_name?: unknown;
  company_address_line1?: unknown;
  company_address_line2?: unknown;
  company_city?: unknown;
  company_province?: unknown;
  company_postal_code?: unknown;
  company_email?: unknown;
  company_phone?: unknown;
  company_vat?: unknown;
  company_bank_name?: unknown;
  company_bank_account_number?: unknown;
  company_bank_branch_code?: unknown;
  company_logo_data?: unknown;
  company_primary_color?: unknown;
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** The shown digest, or '' when the row has no approval digest (then nothing matches it). */
export function shownDigestOf(row: ShownRow): string {
  const approval = row.approval_content_digest;
  if (typeof approval !== 'string' || approval === '') return '';
  const shown = [approval, text(row.notes), text(row.due_date), text(row.billing_period_start), text(row.billing_period_end),
    text(row.project_name), text(row.customer_name), text(row.customer_address), text(row.customer_contact),
    text(row.customer_email), text(row.customer_phone), text(row.customer_vat), text(row.company_name),
    text(row.company_address_line1), text(row.company_address_line2), text(row.company_city), text(row.company_province),
    text(row.company_postal_code), text(row.company_email), text(row.company_phone), text(row.company_vat),
    text(row.company_bank_name), text(row.company_bank_account_number), text(row.company_bank_branch_code),
    text(row.company_logo_data), text(row.company_primary_color)];
  return createHash('sha256').update(JSON.stringify(shown)).digest('hex');
}

/** This company's invoice's shown digest, read now ('' when there is no such invoice). */
export async function readShownDigest(q: TxSql, companyId: string, invoiceId: string): Promise<string> {
  const rows = (await q`
    SELECT approval_document_digest(ci.company_id, 'customer_invoice', ci.id) AS approval_content_digest, ci.notes,
           to_char(ci.due_date, 'YYYY-MM-DD') AS due_date,
           to_char(ci.billing_period_start, 'YYYY-MM-DD') AS billing_period_start,
           to_char(ci.billing_period_end, 'YYYY-MM-DD') AS billing_period_end,
           (SELECT p.name FROM projects p WHERE p.id = ci.project_id AND p.company_id = ci.company_id) AS project_name,
           c.name AS customer_name, c.billing_address AS customer_address, c.contact_person AS customer_contact,
           c.email AS customer_email, c.phone AS customer_phone, c.vat_number AS customer_vat,
           co.name AS company_name, co.address_line1 AS company_address_line1, co.address_line2 AS company_address_line2,
           co.city AS company_city, co.province AS company_province, co.postal_code AS company_postal_code,
           co.email AS company_email, co.phone AS company_phone, co.vat_number AS company_vat,
           co.bank_name AS company_bank_name, co.bank_account_number AS company_bank_account_number,
           co.bank_branch_code AS company_bank_branch_code, co.logo_data AS company_logo_data,
           co.primary_color AS company_primary_color
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id) AND c.company_id = ci.company_id
      LEFT JOIN companies co ON co.id = ci.company_id
      WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}
  `) as ShownRow[];
  return rows[0] ? shownDigestOf(rows[0]) : '';
}

/** A draft PUT edited from `expected` (the shown digest its page last had), when the invoice has moved since. */
export async function shownDigestMoved(q: TxSql, companyId: string, invoiceId: string, expected: string | undefined): Promise<boolean> {
  return expected !== undefined && expected !== await readShownDigest(q, companyId, invoiceId);
}
