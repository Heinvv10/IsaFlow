/**
 * What the SENDER's outbox reads, all of it the sending company's own data under its own RLS: the connection a customer is
 * the partner on (the P1 side row), the sender's identity, and the document snapshot a message carries. It never reads the
 * partner's books. Runs on the request's transaction (inside the approval).
 */
import { sql } from '@/lib/neon';
import type { CreditNoteSource, InvoiceSource } from './mirrorPayload';

type Row = Record<string, unknown>;

const num = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string | null => (v == null ? null : String(v));

export interface OutboxRoute {
  connectionId: string;
  kind: 'group' | 'external';
  partnerCompanyId: string;
  cutoverDate: string | null;
}

/**
 * The live connection this company's customer is the partner on, or null. A customer is linked to one connection per
 * company (the partial unique index of 1000), so this is at most one row; only an ACTIVE connection counts.
 */
export async function routeForCustomer(companyId: string, customerId: string): Promise<OutboxRoute | null> {
  const rows = (await sql`
    SELECT c.id, c.kind, to_char(c.cutover_date, 'YYYY-MM-DD') AS cutover_date,
           CASE WHEN c.company_low_id = ${companyId}::UUID THEN c.company_high_id ELSE c.company_low_id END AS partner_company_id
      FROM intercompany_connection_sides s
      JOIN intercompany_connections c ON c.id = s.connection_id AND c.status = 'active'
     WHERE s.company_id = ${companyId}::UUID AND s.customer_id = ${customerId}::UUID
     LIMIT 1
  `) as Row[];
  const r = rows[0];
  if (!r) return null;
  return {
    connectionId: String(r.id), kind: String(r.kind) as OutboxRoute['kind'],
    partnerCompanyId: String(r.partner_company_id), cutoverDate: str(r.cutover_date),
  };
}

export async function senderIdentity(companyId: string): Promise<{ name: string; vatNumber: string | null }> {
  const rows = (await sql`SELECT name, vat_number FROM companies WHERE id = ${companyId}::UUID`) as Row[];
  return { name: String(rows[0]?.name ?? 'Unknown company'), vatNumber: str(rows[0]?.vat_number) };
}

/** An approved customer invoice as a message carries it, with the customer it is for; null when it is not this company's. */
export async function readInvoiceSource(companyId: string, invoiceId: string): Promise<(InvoiceSource & { customerId: string; glJournalEntryId: string | null }) | null> {
  const rows = (await sql`
    SELECT ci.invoice_number, to_char(ci.invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(ci.due_date, 'YYYY-MM-DD') AS due_date,
           ci.currency_code, ci.subtotal, ci.tax_amount, ci.total_amount, ci.notes,
           COALESCE(ci.client_id, ci.customer_id) AS customer_id, ci.gl_journal_entry_id,
           ci.rendered_pdf_storage_path, ci.rendered_pdf_sha256
      FROM customer_invoices ci
     WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID AND ci.deleted_at IS NULL
  `) as Row[];
  const r = rows[0];
  if (!r) return null;
  const items = (await sql`
    SELECT description, quantity, unit_price, amount, tax_rate
      FROM customer_invoice_items
     WHERE invoice_id = ${invoiceId}::UUID
     ORDER BY line_position NULLS LAST, created_at, id
  `) as Row[];
  const sender = await senderIdentity(companyId);
  return {
    number: String(r.invoice_number), date: String(r.invoice_date), dueDate: str(r.due_date),
    currency: String(r.currency_code ?? 'ZAR'),
    subtotal: num(r.subtotal), taxAmount: num(r.tax_amount), total: num(r.total_amount), notes: str(r.notes),
    sender,
    lines: items.map((i) => ({
      description: String(i.description), quantity: num(i.quantity), unitPrice: num(i.unit_price),
      amount: num(i.amount), taxRate: num(i.tax_rate),
    })),
    pdf: r.rendered_pdf_storage_path && r.rendered_pdf_sha256
      ? { path: String(r.rendered_pdf_storage_path), sha256: String(r.rendered_pdf_sha256) } : null,
    customerId: String(r.customer_id), glJournalEntryId: str(r.gl_journal_entry_id),
  };
}

/** An approved CUSTOMER credit note as a message carries it; null when it is not this company's customer note. */
export async function readCreditNoteSource(companyId: string, creditNoteId: string): Promise<(CreditNoteSource & { customerId: string; glJournalEntryId: string | null }) | null> {
  const rows = (await sql`
    SELECT cn.credit_note_number, to_char(cn.credit_date, 'YYYY-MM-DD') AS credit_date, cn.currency, cn.subtotal, cn.tax_amount,
           cn.total_amount, cn.tax_rate, cn.reason, cn.client_id, cn.gl_journal_entry_id, ci.invoice_number AS invoice_number
      FROM credit_notes cn
      LEFT JOIN customer_invoices ci ON ci.id = cn.customer_invoice_id AND ci.company_id = cn.company_id
     WHERE cn.id = ${creditNoteId}::UUID AND cn.company_id = ${companyId}::UUID AND cn.type = 'customer'
  `) as Row[];
  const r = rows[0];
  if (!r || !r.client_id) return null;
  return {
    number: r.credit_note_number ? String(r.credit_note_number) : `CN-${creditNoteId.slice(0, 8)}`,
    date: String(r.credit_date), currency: String(r.currency ?? 'ZAR'),
    subtotal: num(r.subtotal), taxAmount: num(r.tax_amount), total: num(r.total_amount), taxRate: num(r.tax_rate),
    reason: str(r.reason), creditsInvoiceNumber: str(r.invoice_number), sender: await senderIdentity(companyId),
    customerId: String(r.client_id), glJournalEntryId: str(r.gl_journal_entry_id),
  };
}
