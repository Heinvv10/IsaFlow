/**
 * The receiver's locks and reads for accepting a `payment` message (intercompany F). ONE lock order for accept, discard and confirm (plan (k)
 * M-3, (l) MED-4): the message FOR UPDATE, then the payer's keys (`intercompany_allocation_cap_lock`, accept only, BEFORE the guard's own
 * connection share), then the receipt FOR UPDATE, then the invoices (the receipts' own bounded lock). Each its own statement on the request's
 * transaction; RLS limits every row to the session company, which each query names too.
 */
import { sql } from '@/lib/neon';
import { AR_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import { lockReceiptInvoices } from '../ar/receiptInvoiceLock';
import type { PaymentState } from './paymentInboxTypes';
import type { DraftInvoiceFacts } from './paymentAcceptRules';
import { cents, wholeCents } from './paymentAcceptRules';

type Row = Record<string, unknown>;
const OPEN: ReadonlySet<string> = new Set(AR_OPEN_STATUSES);

export interface LockedPayment { id: string; status: string; connectionId: string; payload: unknown }

/** The message FOR UPDATE (this company's payment message), then the payer's keys; null when it is not one. */
export async function lockPaymentMessage(companyId: string, messageId: string): Promise<LockedPayment | null> {
  const [r] = (await sql`
    SELECT id, status, connection_id, payload FROM intercompany_messages
     WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND kind = 'payment' AND source_doc_type = 'payment_allocation'
       FOR UPDATE
  `) as Row[];
  if (!r) return null;
  await sql`SELECT public.intercompany_allocation_cap_lock(${messageId}::UUID)`;
  return { id: String(r.id), status: String(r.status), connectionId: String(r.connection_id), payload: r.payload };
}

/** D2's word, asked under the locks. Exactly one row, or a throw: the accept never goes on a defaulted answer. */
export async function stateNow(messageId: string): Promise<PaymentState> {
  const rows = (await sql`SELECT state FROM public.intercompany_payment_message_state(${messageId}::UUID)`) as Row[];
  if (rows.length !== 1) throw new Error('the payment message state did not answer exactly one row');
  return String(rows[0]!.state) as PaymentState;
}

/** An existing receipt, held FOR UPDATE: is it a target H2 takes (the guard's own rule), and how much of it is unconsumed. */
export async function existingFacts(companyId: string, m: LockedPayment, receiptId: string): Promise<{ ok: boolean; unconsumedCents: number }> {
  const [r] = (await sql`
    SELECT p.total_amount::numeric AS total FROM customer_payments p WHERE p.id = ${receiptId}::UUID AND p.company_id = ${companyId}::UUID FOR UPDATE
  `) as Row[];
  if (!r) return { ok: false, unconsumedCents: 0 };
  const [c] = (await sql`
    SELECT COALESCE(sum(round((x.payload ->> 'amount')::numeric, 2)), 0)::float8 AS consumed FROM intercompany_messages x
     WHERE x.to_company_id = ${companyId}::UUID AND x.kind = 'payment' AND x.status = 'accepted' AND x.id <> ${m.id}::UUID
       AND x.target_doc_type = 'customer_payment' AND x.target_doc_id = ${receiptId}::UUID AND jsonb_typeof(x.payload -> 'amount') = 'number'
  `) as Row[];
  const [ok] = (await sql`
    SELECT public.intercompany_payment_target_ok(x.id, x.payload, x.connection_id, x.to_company_id, 'customer_payment', ${receiptId}::UUID) AS ok
      FROM intercompany_messages x WHERE x.id = ${m.id}::UUID AND x.to_company_id = ${companyId}::UUID
  `) as Row[];
  return { ok: ok?.ok === true, unconsumedCents: cents(Number(r.total)) - cents(Number(c?.consumed ?? 0)) };
}

/** A bank account of this company the receipt may name: an active, non-header account of subtype bank. */
export async function bankAccountOk(companyId: string, accountId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 AS one FROM gl_accounts ga
     WHERE ga.id = ${accountId}::UUID AND ga.company_id = ${companyId}::UUID AND ga.account_subtype = 'bank' AND ga.is_active IS NOT FALSE
       AND NOT EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.parent_account_id = ga.id AND ch.company_id = ga.company_id)
  `) as Row[];
  return rows.length === 1;
}

/** The picked invoices, LOCKED (ascending id: the receipts' own lock, which createCustomerPayment takes again re-entrantly), and their facts. */
export async function draftInvoiceFacts(companyId: string, picks: { invoiceId: string; amount: number }[], customerId: string | null,
  cutover: string | null): Promise<DraftInvoiceFacts[]> {
  await lockReceiptInvoices(companyId, picks.map((p) => p.invoiceId));
  const rows = (await sql`
    SELECT ci.id, ci.status, COALESCE(ci.client_id, ci.customer_id) AS customer, upper(COALESCE(NULLIF(ci.currency_code, ''), 'ZAR')) AS currency,
           to_char(ci.invoice_date, 'YYYY-MM-DD') AS date,
           (ci.total_amount - COALESCE(ci.amount_paid, 0) - COALESCE((
              SELECT sum(a.amount_allocated) FROM customer_payment_allocations a
                JOIN customer_payments p ON p.id = a.payment_id AND p.company_id = ${companyId}::UUID AND p.status = 'draft'
               WHERE a.invoice_id = ci.id), 0))::float8 AS open
      FROM customer_invoices ci
     WHERE ci.company_id = ${companyId}::UUID AND ci.deleted_at IS NULL AND ci.id = ANY(${picks.map((p) => p.invoiceId)}::UUID[])
  `) as Row[];
  const byId = new Map(rows.map((r) => [String(r.id).toLowerCase(), r]));
  return picks.map((p) => {
    const r = byId.get(p.invoiceId.toLowerCase());
    return {
      id: p.invoiceId, amountCents: cents(p.amount), wholeCents: wholeCents(p.amount), own: !!r,
      customer: !!r && !!customerId && String(r.customer ?? '').toLowerCase() === customerId.toLowerCase(),
      open: !!r && OPEN.has(String(r.status)), zar: !!r && r.currency === 'ZAR',
      onOrAfterCutover: !!r && !!cutover && !!r.date && String(r.date) >= cutover,
      openLessDraftsCents: r ? cents(Number(r.open)) : 0,
    };
  });
}

/** Stamp the new draft for this message (only the accept stamps IC:; createCustomerPayment refuses a caller's). */
export async function stampDraft(companyId: string, paymentId: string, messageId: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE customer_payments SET bank_reference = ${`IC:${messageId}`}
     WHERE id = ${paymentId}::UUID AND company_id = ${companyId}::UUID AND status = 'draft' AND bank_reference IS NULL
     RETURNING id
  `) as Row[];
  return rows.length === 1;
}

/** The accepted transition (the guard judges it again: H2, consumption). */
export async function markAccepted(companyId: string, messageId: string, receiptId: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE intercompany_messages SET status = 'accepted', target_doc_type = 'customer_payment', target_doc_id = ${receiptId}::UUID, error = NULL
     WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND kind = 'payment' AND status = 'pending'
     RETURNING id
  `) as Row[];
  return rows.length === 1;
}
