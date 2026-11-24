/**
 * The receiver's match suggestions for a `payment` message (intercompany F, plan (a).2, (l) MED-2), computed on request and never stored.
 * READ ONLY, and over the RECEIVER's OWN rows only (the request's transaction: RLS limits every row to the session company, and each query
 * names it): its side of the connection (the customer), the connection's cut-over, its customer invoices, customer receipts and their
 * allocations, its accepted payment messages (what they consumed of a receipt), its unmatched incoming bank lines and its bank accounts.
 * Nothing of the payer is read: the ranking (paymentRanking.ts) uses the payload's amount, date and reference text only.
 *
 * Receipt candidates (MED-2; H2 in migration 1031 judges the same set): the customer's confirmed / reconciled non-contra receipts dated on or
 * after the payment, on a posted journal never reversed, not the F draft of another message (its target AND its stamp: LOW-2), whose
 * unconsumed amount covers the payment and which hold an allocation on the linked invoice or have that much unallocated.
 */
import { sql } from '@/lib/neon';
import { AR_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import { todaySast } from './allocationClearDate';
import { BANK_SUBTYPES } from '../gl/accountSubtypes';
import { draftRefusal, orderInvoices, rankBankLines, rankReceipts, type ReceiptRow } from './paymentRanking';
import type { PaymentPayload } from './paymentPayload';
import type { InvoiceSuggestion, PaymentSuggestions, ReceiptSuggestion } from './paymentInboxTypes';

type Row = Record<string, unknown>;
const OPEN = [...AR_OPEN_STATUSES] as string[];
const text = (v: unknown): string | null => (v == null ? null : String(v));

export interface SuggestionScope { companyId: string; messageId: string; connectionId: string; payload: PaymentPayload }

/** The receiver side's customer for the payer, and the connection's cut-over (both the receiver's own reads). */
export async function scopeOf(companyId: string, connectionId: string): Promise<{ customerId: string | null; cutover: string | null }> {
  const [r] = (await sql`
    SELECT s.customer_id, to_char(c.cutover_date, 'YYYY-MM-DD') AS cutover
      FROM intercompany_connections c
      LEFT JOIN intercompany_connection_sides s ON s.connection_id = c.id AND s.company_id = ${companyId}::UUID
     WHERE c.id = ${connectionId}::UUID AND (c.company_low_id = ${companyId}::UUID OR c.company_high_id = ${companyId}::UUID)
  `) as Row[];
  return { customerId: text(r?.customer_id), cutover: text(r?.cutover) };
}

/** The customer's open rand invoices dated on or after the cut-over, with what is still open less the draft receipts on them. */
export async function openInvoices(companyId: string, customerId: string, cutover: string): Promise<InvoiceSuggestion[]> {
  const rows = (await sql`
    SELECT ci.id, ci.invoice_number, to_char(ci.invoice_date, 'YYYY-MM-DD') AS date,
           (ci.total_amount - COALESCE(ci.amount_paid, 0) - COALESCE((
              SELECT sum(a.amount_allocated) FROM customer_payment_allocations a
                JOIN customer_payments p ON p.id = a.payment_id AND p.company_id = ${companyId}::UUID AND p.status = 'draft'
               WHERE a.invoice_id = ci.id), 0))::float8 AS open
      FROM customer_invoices ci
     WHERE ci.company_id = ${companyId}::UUID AND ci.deleted_at IS NULL AND COALESCE(ci.client_id, ci.customer_id) = ${customerId}::UUID
       AND ci.status = ANY(${OPEN}::TEXT[]) AND upper(COALESCE(NULLIF(ci.currency_code, ''), 'ZAR')) = 'ZAR'
       AND ci.invoice_date >= ${cutover}::DATE
     ORDER BY ci.invoice_date, ci.id
     LIMIT 200
  `) as Row[];
  return rows.filter((r) => Number(r.open) > 0.004).map((r) => ({
    id: String(r.id), number: String(r.invoice_number ?? ''), date: text(r.date), openAmount: Number(r.open), linked: false,
  }));
}

/** The MED-2 receipt candidates, ranked. */
export async function receiptCandidates(s: SuggestionScope, customerId: string): Promise<ReceiptSuggestion[]> {
  const { companyId, messageId, payload } = s;
  const rows = (await sql`
    WITH r AS (
      SELECT p.id, p.payment_number, to_char(p.payment_date, 'YYYY-MM-DD') AS date, p.total_amount::numeric AS total,
             COALESCE(p.bank_reference, '') || ' ' || COALESCE(p.description, '') AS words,
             COALESCE((SELECT sum(a.amount_allocated) FROM customer_payment_allocations a WHERE a.payment_id = p.id), 0) AS allocated,
             COALESCE((SELECT sum(round((x.payload ->> 'amount')::numeric, 2)) FROM intercompany_messages x
                        WHERE x.to_company_id = ${companyId}::UUID AND x.kind = 'payment' AND x.status = 'accepted' AND x.id <> ${messageId}::UUID
                          AND x.target_doc_type = 'customer_payment' AND x.target_doc_id = p.id AND jsonb_typeof(x.payload -> 'amount') = 'number'), 0) AS consumed,
             EXISTS (SELECT 1 FROM customer_payment_allocations a WHERE a.payment_id = p.id AND a.invoice_id = ${payload.issuerDocument.id}::UUID) AS on_linked
        FROM customer_payments p
       WHERE p.company_id = ${companyId}::UUID AND p.client_id = ${customerId}::UUID AND p.status IN ('confirmed', 'reconciled')
         AND p.payment_method IS DISTINCT FROM 'contra' AND p.payment_date >= ${payload.payment.date}::DATE AND p.gl_journal_entry_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM gl_journal_entries je WHERE je.id = p.gl_journal_entry_id AND je.company_id = ${companyId}::UUID AND je.status = 'posted')
         AND NOT EXISTS (SELECT 1 FROM gl_journal_entries rv WHERE rv.reversal_of_id = p.gl_journal_entry_id AND rv.company_id = ${companyId}::UUID)
         AND NOT EXISTS (SELECT 1 FROM intercompany_messages x
                          WHERE x.to_company_id = ${companyId}::UUID AND x.kind = 'payment' AND x.status = 'accepted' AND x.id <> ${messageId}::UUID
                            AND x.target_doc_type = 'customer_payment' AND x.target_doc_id = p.id AND p.bank_reference = 'IC:' || x.id::TEXT)
    )
    SELECT id, payment_number, date, total::float8 AS total, words, allocated::float8 AS allocated, consumed::float8 AS consumed, on_linked
      FROM r
     WHERE total - consumed >= ${payload.amount} AND (on_linked OR total - allocated >= ${payload.amount})
     ORDER BY date, id
     LIMIT 100
  `) as Row[];
  const mapped: ReceiptRow[] = rows.map((r) => ({
    id: String(r.id), number: String(r.payment_number ?? ''), date: String(r.date), total: Number(r.total), allocated: Number(r.allocated),
    consumed: Number(r.consumed), onLinkedInvoice: r.on_linked === true, text: String(r.words ?? ''),
  }));
  return rankReceipts(rankBasis(payload), mapped);
}

const rankBasis = (p: PaymentPayload) => ({ amount: p.amount, date: p.payment.date, reference: p.payment.reference, number: p.payment.number });

/** Everything the detail offers for an open message (a hint list of bank lines included). */
export async function suggestionsFor(s: SuggestionScope): Promise<PaymentSuggestions> {
  const { companyId, payload } = s;
  const scope = await scopeOf(companyId, s.connectionId);
  const today = await todaySast();
  const invoices = scope.customerId && scope.cutover ? await openInvoices(companyId, scope.customerId, scope.cutover) : [];
  const receipts = scope.customerId ? await receiptCandidates(s, scope.customerId) : [];
  const lines = (await sql`
    SELECT bt.id, to_char(bt.transaction_date, 'YYYY-MM-DD') AS date, bt.amount::float8 AS amount, COALESCE(bt.description, '') || ' ' || COALESCE(bt.reference, '') AS description
      FROM bank_transactions bt
     WHERE bt.company_id = ${companyId}::UUID AND bt.amount > 0 AND bt.status = 'imported' AND bt.feed_state = 'posted'
       AND bt.transaction_date >= ${payload.payment.date}::DATE - 30
     ORDER BY abs(bt.amount - ${payload.amount}), bt.transaction_date, bt.id
     LIMIT 20
  `) as Row[];
  const accounts = (await sql`
    SELECT ga.id, ga.account_code, ga.account_name FROM gl_accounts ga
     WHERE ga.company_id = ${companyId}::UUID AND ga.account_subtype = ANY(${BANK_SUBTYPES as string[]}) AND ga.is_active IS NOT FALSE
       AND NOT EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.parent_account_id = ga.id AND ch.company_id = ga.company_id)
     ORDER BY ga.account_code, ga.id
  `) as Row[];
  const block = draftRefusal(receipts);
  return {
    invoices: orderInvoices(payload.issuerDocument.id, invoices),
    receipts,
    bankLines: rankBankLines(rankBasis(payload), lines.map((l) => ({ id: String(l.id), date: String(l.date), amount: Number(l.amount), description: String(l.description).trim() }))),
    bankAccounts: accounts.map((a) => ({ id: String(a.id), label: `${String(a.account_code ?? '')} ${String(a.account_name ?? '')}`.trim() })),
    draftAllowed: block === null,
    draftRefusal: block,
    today,
  };
}
