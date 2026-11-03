/**
 * The customer invoice as the PDF renders it (PR S rounds fourteen and fifteen): ONE loader for the data model the PDF
 * builder consumes, and the two digests made from it.
 *
 * `loadInvoicePdfModel` reads what the PDF prints: the header (number, dates, status, terms, totals, VAT, notes, the
 * job's name), the customer as printed (name, address, contact, email, phone, VAT number), the issuing company as
 * printed (name, address, contact details, VAT number, bank details, logo, colour) and the lines. The header also
 * carries the currency, the exchange rate and the billing period: the invoice page shows them; the PDF does not print
 * them (it prints every amount with the rand symbol, whatever the invoice's currency: a known, older defect).
 * `invoicePdfBuilder` renders this model and nothing else, so whatever it prints is in the model by construction.
 *
 * Two digests, each with the approval digest (the content approval vouches for, line coding included):
 *   - `shown`: the whole model. Approve compares it, recomputed under its row lock (409 STALE_VIEW).
 *   - `draft`: the invoice row and its lines only, what a draft PUT's row lock covers. A customer or company record
 *     edited meanwhile does not refuse an open draft's autosave; it refuses its approve, if printed.
 * Read with `forDigest`, the company's logo comes back as its md5 (a logo can be megabytes); two statements in all.
 * Lines are ordered by created_at, id, and hashed as a set besides.
 */
import { createHash } from 'node:crypto';
import { sql, type TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getCompanyDetailsFromCompany, type PrintedCompany } from '../core/pdfShared';

/** The invoice row's own fields (all a draft PUT's lock covers), as printed or shown. */
const INVOICE_FIELDS = ['invoice_number', 'invoice_date', 'due_date', 'status', 'payment_terms', 'subtotal', 'tax_rate',
  'tax_amount', 'total_amount', 'amount_paid', 'currency_code', 'exchange_rate', 'notes', 'billing_period_start',
  'billing_period_end'] as const;
/** Joined from other tables (the customer, the job), as printed. */
const JOINED_FIELDS = ['project_name', 'client_name', 'client_address', 'client_contact', 'client_email', 'client_phone',
  'client_vat'] as const;

export type InvoicePdfHeader = Record<(typeof INVOICE_FIELDS)[number] | (typeof JOINED_FIELDS)[number], unknown>;
export interface InvoicePdfLine { description: unknown; quantity: unknown; unit_price: unknown; amount: unknown; tax_rate: unknown }
export interface InvoicePdfModel { company: PrintedCompany; invoice: InvoicePdfHeader; items: InvoicePdfLine[] }
export interface InvoiceDigests { shown: string; draft: string }

type Row = Record<string, unknown>;
const text = (v: unknown): string => (v ? String(v) : '');
const pick = <K extends string>(r: Row, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null])) as Record<K, unknown>;

async function load(q: TxSql, companyId: string, invoiceId: string, forDigest: boolean):
  Promise<{ model: InvoicePdfModel; approvalDigest: string } | null> {
  const rows = (await q`
    SELECT ci.invoice_number, ci.invoice_date, ci.due_date, ci.status,
           NULL::TEXT AS payment_terms, -- customer_invoices has no terms column: the PDF prints its constant
           ci.subtotal, ci.tax_rate, ci.tax_amount, ci.total_amount, ci.amount_paid, ci.currency_code, ci.exchange_rate,
           ci.notes, ci.billing_period_start, ci.billing_period_end, p.name AS project_name,
           c.name AS client_name, c.billing_address AS client_address, c.contact_person AS client_contact,
           c.email AS client_email, c.phone AS client_phone, c.vat_number AS client_vat,
           approval_document_digest(ci.company_id, 'customer_invoice', ci.id) AS approval_digest,
           co.id IS NOT NULL AS company_found, co.name AS company_name, co.address_line1, co.address_line2, co.city,
           co.province, co.postal_code, co.phone AS company_phone, co.email AS company_email, co.vat_number AS company_vat,
           co.bank_name, co.bank_account_number, co.bank_branch_code, co.primary_color,
           CASE WHEN ${forDigest}::BOOLEAN THEN md5(co.logo_data) ELSE co.logo_data END AS company_logo
    FROM customer_invoices ci
    -- Each join carries company_id: a drifted client or project id must not print another tenant's data.
    LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id) AND c.company_id = ci.company_id
    LEFT JOIN projects p ON p.id = ci.project_id AND p.company_id = ci.company_id
    LEFT JOIN companies co ON co.id = ci.company_id
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
  `) as Row[];
  const r = rows[0];
  if (!r) return null;
  const items = (await q`
    SELECT cii.description, cii.quantity, cii.unit_price, cii.amount, cii.tax_rate
    FROM customer_invoice_items cii JOIN customer_invoices ci ON ci.id = cii.invoice_id
    WHERE cii.invoice_id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
    ORDER BY cii.created_at, cii.id
  `) as InvoicePdfLine[];
  const invoice = { ...pick(r, INVOICE_FIELDS), ...pick(r, JOINED_FIELDS) };
  const company = r.company_found ? companyOf(r) : await settingsCompany(companyId, invoiceId, forDigest);
  return { model: { company, invoice, items }, approvalDigest: text(r.approval_digest) };
}

/** As getCompanyDetailsFromCompany maps a companies row, printed fields only. */
function companyOf(r: Row): PrintedCompany {
  return {
    name: r.company_name ? String(r.company_name) : 'Company Name Not Set',
    address: [r.address_line1, r.address_line2, r.city, r.province, r.postal_code].filter(Boolean).map(String).join(', '),
    phone: text(r.company_phone), email: text(r.company_email), vatNumber: text(r.company_vat),
    bankName: text(r.bank_name), bankAccountName: text(r.company_name), bankAccountNumber: text(r.bank_account_number),
    bankBranchCode: text(r.bank_branch_code), logoData: r.company_logo ? String(r.company_logo) : null,
    primaryColor: r.primary_color ? String(r.primary_color) : '#0f766e',
  };
}

/** No companies row: the PDF's own fallback (app settings), logged; printed fields only. */
async function settingsCompany(companyId: string, invoiceId: string, forDigest: boolean): Promise<PrintedCompany> {
  log.warn('Invoice PDF: no companies row, company details from app settings', { companyId, invoiceId }, 'invoicePdfModel');
  const d = await getCompanyDetailsFromCompany(companyId);
  const logoData = d.logoData && forDigest ? createHash('md5').update(d.logoData).digest('hex') : d.logoData;
  return { name: d.name, address: d.address, phone: d.phone, email: d.email, vatNumber: d.vatNumber, bankName: d.bankName,
    bankAccountName: d.bankAccountName, bankAccountNumber: d.bankAccountNumber, bankBranchCode: d.bankBranchCode,
    logoData, primaryColor: d.primaryColor };
}

/** This company's invoice as the PDF renders it, or null when there is no such invoice. */
export async function loadInvoicePdfModel(companyId: string, invoiceId: string,
  opts: { forDigest?: boolean; q?: TxSql } = {}): Promise<InvoicePdfModel | null> {
  return (await load(opts.q ?? sql, companyId, invoiceId, Boolean(opts.forDigest)))?.model ?? null;
}

const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const lineSet = (items: readonly InvoicePdfLine[]) => items.map((l) => JSON.stringify(l)).sort();

/** The shown digest: every section of the model, and the approval digest. */
export function shownDigestOfModel(model: InvoicePdfModel, approvalDigest: string): string {
  return sha([approvalDigest, model.company, model.invoice, lineSet(model.items)]);
}

/** The draft digest: the invoice row's own fields and its lines (no customer, job or company), and the approval digest. */
export function draftDigestOfModel(model: InvoicePdfModel, approvalDigest: string): string {
  return sha([approvalDigest, pick(model.invoice, INVOICE_FIELDS), lineSet(model.items)]);
}

/** Both digests of this company's invoice, read now (null when there is no such invoice). Two statements. */
export async function invoiceDigests(companyId: string, invoiceId: string, q: TxSql = sql): Promise<InvoiceDigests | null> {
  const loaded = await load(q, companyId, invoiceId, true);
  if (!loaded) return null;
  return { shown: shownDigestOfModel(loaded.model, loaded.approvalDigest), draft: draftDigestOfModel(loaded.model, loaded.approvalDigest) };
}

/** A draft PUT edited from `expected` (the draft digest its page last had), when the invoice row or lines moved since. */
export async function draftDigestMoved(q: TxSql, companyId: string, invoiceId: string, expected: string | undefined): Promise<boolean> {
  return expected !== undefined && expected !== (await invoiceDigests(companyId, invoiceId, q))?.draft;
}
