/**
 * The customer invoice as the PDF renders it (PR S round fourteen): ONE loader for the data model the PDF builder
 * consumes, and the shown digest made from it.
 *
 * `loadInvoicePdfModel` reads everything the PDF prints: the header (number, dates, status, terms, totals, VAT,
 * currency, rate, notes, billing period, the job's name), the customer as printed (name, address, contact, email,
 * phone, VAT number), the issuing company as printed (name, address, contact details, VAT number, bank details,
 * logo, colour, layout) and the lines. `invoicePdfBuilder` renders this model and nothing else, so whatever it
 * prints is in the model by construction.
 *
 * `shownDigest` hashes that model with the approval digest (the content approval vouches for: line coding included).
 * Every reply that hands a page an invoice carries it (the detail GET's `shown_digest`, the create's and each draft
 * PUT's `shownDigest`), and the approval and the draft edit recompute it under their row lock: a printed field that
 * changed since the page read the invoice is refused (409 STALE_VIEW). Lines are hashed as a set (their printed order
 * among equal `created_at` is not stable between reads); nothing else is normalised.
 */
import { createHash } from 'node:crypto';
import { sql } from '@/lib/neon';
import { getCompanyDetailsFromCompany, type CompanyDetails } from '../core/pdfShared';

/** The invoice header as printed, with the customer and the job joined (both company-scoped). */
export interface InvoicePdfHeader {
  invoice_number: unknown; invoice_date: unknown; due_date: unknown; status: unknown; payment_terms: unknown;
  subtotal: unknown; tax_rate: unknown; tax_amount: unknown; total_amount: unknown; amount_paid: unknown;
  currency_code: unknown; exchange_rate: unknown; notes: unknown; billing_period_start: unknown; billing_period_end: unknown;
  project_name: unknown;
  client_name: unknown; client_address: unknown; client_contact: unknown; client_email: unknown; client_phone: unknown;
  client_vat: unknown;
}

export interface InvoicePdfLine {
  description: unknown; quantity: unknown; unit_price: unknown; amount: unknown; tax_rate: unknown;
}

export interface InvoicePdfModel { company: CompanyDetails; invoice: InvoicePdfHeader; items: InvoicePdfLine[] }

/** This company's invoice as the PDF renders it, or null when there is no such invoice. */
export async function loadInvoicePdfModel(companyId: string, invoiceId: string): Promise<InvoicePdfModel | null> {
  const rows = (await sql`
    SELECT ci.invoice_number, ci.invoice_date, ci.due_date, ci.status,
           NULL::TEXT AS payment_terms, -- customer_invoices has no terms column: the PDF prints its constant
           ci.subtotal, ci.tax_rate, ci.tax_amount, ci.total_amount, ci.amount_paid, ci.currency_code, ci.exchange_rate,
           ci.notes, ci.billing_period_start, ci.billing_period_end,
           p.name AS project_name,
           c.name AS client_name, c.billing_address AS client_address, c.contact_person AS client_contact,
           c.email AS client_email, c.phone AS client_phone, c.vat_number AS client_vat
    FROM customer_invoices ci
    -- Both joins carry company_id. customer_invoices.client_id has no FK, so a
    -- drifted id would print another tenant's customer name, VAT number and
    -- billing address onto a customer-facing tax invoice.
    LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id) AND c.company_id = ci.company_id
    -- Scoped: project_id carries no FK, so an unscoped join would print
    -- another company's project name on this invoice.
    LEFT JOIN projects p ON p.id = ci.project_id AND p.company_id = ci.company_id
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
  `) as InvoicePdfHeader[];
  if (rows.length === 0) return null;
  const items = (await sql`
    SELECT description, quantity, unit_price, amount, tax_rate
    FROM customer_invoice_items WHERE invoice_id = ${invoiceId}::UUID
    ORDER BY created_at
  `) as InvoicePdfLine[];
  return { company: await getCompanyDetailsFromCompany(companyId), invoice: rows[0]!, items };
}

/** The shown digest of a model and its approval digest. Every section of the model is in it. */
export function shownDigestOfModel(model: InvoicePdfModel, approvalDigest: string): string {
  const lines = model.items.map((l) => JSON.stringify(l)).sort();
  return createHash('sha256').update(JSON.stringify([approvalDigest, model.company, model.invoice, lines])).digest('hex');
}

/** This company's invoice's shown digest, read now ('' when there is no such invoice). */
export async function shownDigest(companyId: string, invoiceId: string): Promise<string> {
  const model = await loadInvoicePdfModel(companyId, invoiceId);
  if (!model) return '';
  const rows = (await sql`
    SELECT approval_document_digest(company_id, 'customer_invoice', id) AS digest
      FROM customer_invoices WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `) as { digest: string | null }[];
  return shownDigestOfModel(model, rows[0]?.digest ?? '');
}

/** A draft PUT edited from `expected` (the shown digest its page last had), when the invoice has moved since. */
export async function shownDigestMoved(companyId: string, invoiceId: string, expected: string | undefined): Promise<boolean> {
  return expected !== undefined && expected !== await shownDigest(companyId, invoiceId);
}
