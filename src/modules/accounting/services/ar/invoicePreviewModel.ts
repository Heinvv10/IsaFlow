/**
 * The unsaved invoice as the PDF would render it (master plan wave 4, PR PV): an `InvoicePdfModel` built from the body
 * create takes, for POST /api/accounting/invoice-pdf-preview. Read-only: one SELECT, no row written, no number taken,
 * nothing metered.
 *
 * - Priced by create's own code (`priceDraftLines`, `draftTaxRate`, `invoiceTotals`), so a preview and a create of the
 *   same body agree to the cent. The client's own totals are never read.
 * - Every id is resolved within the company, in the one statement: the customer (another company's, or none → null,
 *   which the route answers 404) and the header job (another company's, or none → printed as no job, with a note).
 *   The company record is the caller's own. The line coding is not read (invoicePreviewBody).
 * - The currency and exchange rate pass create's rule (`checkDocumentCurrency`): the company's own currency at 1, or a
 *   foreign one only when the company has foreign-currency documents enabled.
 * - No invoice number, status `preview`; the builder adds the "PREVIEW: NOT SAVED" watermark.
 */
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { COMPANY_DEFAULT_TERMS_KEY, companyTermsFromSetting, dueDateWithDefault } from '../shared/paymentTerms';
import { checkDocumentCurrency } from '../shared/documentCurrency';
import { draftTaxRate, priceDraftLines } from './customerInvoiceCreateService';
import { invoiceTotals } from './invoiceLineAmount';
import { companyOf, printedTerms, settingsCompany, type InvoicePdfHeader, type InvoicePdfModel } from './invoicePdfModel';
import type { PreviewBody } from './invoicePreviewBody';

export const JOB_NOT_RECOGNISED = 'The job on this form was not recognised, so none is shown.';

export interface InvoicePreview { model: InvoicePdfModel; notes: string[] }

type Row = Record<string, unknown>;

/** The preview of `body` for `companyId`, or null when the customer is not this company's. Throws create's 400s. */
export async function buildInvoicePreviewModel(companyId: string, body: PreviewBody): Promise<InvoicePreview | null> {
  // Create's validation, in create's order where it can be: lines, then the rate (pure, before the read).
  const priced = priceDraftLines(body.items);
  const rate = draftTaxRate(body.taxRate);

  const rows = (await sql`
    SELECT c.name AS client_name, c.billing_address AS client_address, c.contact_person AS client_contact,
           c.email AS client_email, c.phone AS client_phone, c.vat_number AS client_vat,
           c.payment_terms AS contact_terms_days, c.payment_terms_type AS contact_terms_type,
           ds.value AS company_default_terms, p.name AS project_name,
           co.id IS NOT NULL AS company_found, co.functional_currency, co.fx_documents_enabled,
           co.name AS company_name, co.address_line1, co.address_line2, co.city, co.province, co.postal_code,
           co.phone AS company_phone, co.email AS company_email, co.vat_number AS company_vat, co.bank_name,
           co.bank_account_number, co.bank_branch_code, co.primary_color, co.logo_data AS company_logo
    FROM customers c
    LEFT JOIN companies co ON co.id = c.company_id
    LEFT JOIN accounting_settings ds ON ds.company_id = c.company_id AND ds.key = ${COMPANY_DEFAULT_TERMS_KEY}
    -- The job is printed by name: only this company's.
    LEFT JOIN projects p ON p.id = ${body.projectId}::UUID AND p.company_id = c.company_id
    WHERE c.id = ${body.clientId}::UUID AND c.company_id = ${companyId}::UUID
  `) as Row[];
  const r = rows[0];
  if (!r) return null;

  const currency = checkDocumentCurrency(
    { functionalCurrency: r.functional_currency ? String(r.functional_currency) : 'ZAR', fxDocumentsEnabled: r.fx_documents_enabled === true },
    body.currencyCode, body.exchangeRate, 'invoice',
  );
  const { subtotal, tax, total } = invoiceTotals(priced.map((p) => p.amount), rate);

  const invoiceDate = body.invoiceDate ?? fmtDate(new Date());
  const dueDate = body.dueDate ?? dueDateWithDefault(invoiceDate,
    r.contact_terms_days == null ? null : Number(r.contact_terms_days), r.contact_terms_type as string | null,
    companyTermsFromSetting(r.company_default_terms, companyId));
  const notes: string[] = [];
  if (body.projectNamed && r.project_name == null) notes.push(JOB_NOT_RECOGNISED);

  const invoice: InvoicePdfHeader = {
    invoice_number: null, invoice_date: invoiceDate, due_date: dueDate, status: 'preview', payment_terms: null,
    subtotal, tax_rate: rate, tax_amount: tax, total_amount: total, amount_paid: 0,
    currency_code: currency.currencyCode, exchange_rate: currency.exchangeRate, notes: body.notes,
    billing_period_start: null, billing_period_end: null, project_name: r.project_name ?? null,
    client_name: r.client_name ?? null, client_address: r.client_address ?? null, client_contact: r.client_contact ?? null,
    client_email: r.client_email ?? null, client_phone: r.client_phone ?? null, client_vat: r.client_vat ?? null,
    ...printedTerms({ ...r, invoice_date: invoiceDate, due_date: dueDate }, companyId),
  };
  const items = body.items.map((item, i) => ({
    description: item.description, quantity: priced[i]!.qty, unit_price: priced[i]!.price, amount: priced[i]!.amount, tax_rate: rate,
  }));
  const company = r.company_found ? companyOf(r) : await settingsCompany(companyId, 'preview', false);
  return { model: { company, invoice, items }, notes };
}
