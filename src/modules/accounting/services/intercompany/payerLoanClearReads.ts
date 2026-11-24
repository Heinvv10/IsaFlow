/**
 * The PAYER's reads and row locks for "Clear against the intercompany loan" (P4-E), each its own statement on the request's transaction (RLS
 * limits every row to the session company, which each query names too). THE LOCK ORDER (plan (j).9), the only one:
 *   1. the bill FOR UPDATE (two clearings, or a clearing and a payment, of one bill queue here; the loser re-reads the open amount);
 *   2. the link's connection FOR SHARE, 3. this company's side FOR SHARE, 4. the link FOR SHARE (P4-D's order: connection, side, link);
 *   5. the loan account FOR SHARE (P4-D's `lockLoanAccount`: it cannot be re-typed, deactivated or re-parented under the clearing);
 *   then what the contra settlement and the payment services lock themselves (the bill again, re-entrant; the new payment; the period).
 * The link is first found by an unlocked read (it names the connection to lock) and re-read under its lock in step 4. The preview reads the
 * same facts with the bill unlocked (`lock: false`).
 */
import { sql } from '@/lib/neon';
import {
  lockConnection, lockLoanAccount, pairCutover, type LockedAccount, type LockedConnection,
} from './allocationClearReads';
import { cents } from './allocationClearRefusals';

type Row = Record<string, unknown>;
const text = (v: unknown): string | null => (v == null ? null : String(v));

export interface ClearingBill {
  id: string; number: string; supplierId: string | null; status: string; deleted: boolean; date: string | null;
  totalCents: number; paidCents: number; currency: string;
}

export interface ClearingFacts {
  bill: ClearingBill | null;
  /** The bill's ACTIVE link to a customer invoice of the connection's partner, as read under its lock (null: none). */
  link: { id: string; connectionId: string } | null;
  conn: LockedConnection | null;
  side: { loanAccountId: string | null; supplierId: string | null } | null;
  loan: LockedAccount | null;
  /** The pair's cut-over (`intercompany_pair_cutovers`, P4-D's `pairCutover`), null when the pair has none. */
  cutover: string | null;
  /** What draft / approved supplier payments already claim on the bill, in cents (as `createSupplierPayment` counts them). */
  pendingCents: number;
}

async function readBill(companyId: string, billId: string, lock: boolean): Promise<ClearingBill | null> {
  const rows = (lock
    ? await sql`
        SELECT si.id, si.invoice_number, si.supplier_id, si.status, si.deleted_at, to_char(si.invoice_date, 'YYYY-MM-DD') AS d, si.total_amount,
               COALESCE(si.amount_paid, 0) AS paid, upper(COALESCE(NULLIF(si.currency_code, ''), NULLIF(si.currency, ''), 'ZAR')) AS currency
          FROM supplier_invoices si WHERE si.id = ${billId}::UUID AND si.company_id = ${companyId}::UUID
           FOR UPDATE OF si`
    : await sql`
        SELECT si.id, si.invoice_number, si.supplier_id, si.status, si.deleted_at, to_char(si.invoice_date, 'YYYY-MM-DD') AS d, si.total_amount,
               COALESCE(si.amount_paid, 0) AS paid, upper(COALESCE(NULLIF(si.currency_code, ''), NULLIF(si.currency, ''), 'ZAR')) AS currency
          FROM supplier_invoices si WHERE si.id = ${billId}::UUID AND si.company_id = ${companyId}::UUID`) as Row[];
  const r = rows[0];
  return r ? {
    id: String(r.id), number: String(r.invoice_number), supplierId: text(r.supplier_id), status: String(r.status), deleted: r.deleted_at != null,
    date: text(r.d), totalCents: cents(Number(r.total_amount)), paidCents: cents(Number(r.paid)), currency: String(r.currency),
  } : null;
}

/** The bill's active link joining it (this company's supplier_invoice) to the partner's customer_invoice; `lock` holds it FOR SHARE. */
async function readLink(companyId: string, billId: string, lock: boolean, linkId?: string): Promise<{ id: string; connectionId: string } | null> {
  const rows = (lock
    ? await sql`
        SELECT k.id, k.connection_id FROM intercompany_document_links k
         WHERE k.id = ${linkId ?? null}::UUID AND k.status = 'active'
           AND ((k.company_a_id = ${companyId}::UUID AND k.doc_a_type = 'supplier_invoice' AND k.doc_a_id = ${billId}::UUID AND k.doc_b_type = 'customer_invoice')
             OR (k.company_b_id = ${companyId}::UUID AND k.doc_b_type = 'supplier_invoice' AND k.doc_b_id = ${billId}::UUID AND k.doc_a_type = 'customer_invoice'))
           FOR SHARE`
    : await sql`
        SELECT k.id, k.connection_id FROM intercompany_document_links k
         WHERE k.status = 'active'
           AND ((k.company_a_id = ${companyId}::UUID AND k.doc_a_type = 'supplier_invoice' AND k.doc_a_id = ${billId}::UUID AND k.doc_b_type = 'customer_invoice')
             OR (k.company_b_id = ${companyId}::UUID AND k.doc_b_type = 'supplier_invoice' AND k.doc_b_id = ${billId}::UUID AND k.doc_a_type = 'customer_invoice'))
         ORDER BY k.id LIMIT 1`) as Row[];
  return rows[0] ? { id: String(rows[0].id), connectionId: String(rows[0].connection_id) } : null;
}

/** Step 3: this company's own side (its loan account and the partner's supplier record). */
async function lockPayerSide(companyId: string, connectionId: string): Promise<{ loanAccountId: string | null; supplierId: string | null } | null> {
  const rows = (await sql`
    SELECT s.loan_account_id, s.supplier_id FROM intercompany_connection_sides s
     WHERE s.connection_id = ${connectionId}::UUID AND s.company_id = ${companyId}::UUID
       FOR SHARE
  `) as Row[];
  return rows[0] ? { loanAccountId: text(rows[0].loan_account_id), supplierId: text(rows[0].supplier_id) } : null;
}

async function pendingPaymentCents(companyId: string, billId: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(pa.amount_allocated), 0) AS pending
      FROM payment_allocations pa JOIN supplier_payments sp ON sp.id = pa.payment_id
     WHERE pa.invoice_id = ${billId}::UUID AND sp.company_id = ${companyId}::UUID AND sp.status IN ('draft', 'approved')
  `) as Row[];
  return cents(Number(rows[0]?.pending ?? 0));
}

/** Every fact the clearing judges, read in THE lock order (`lock: true`), or for the preview with the bill unlocked. */
export async function loadClearingFacts(companyId: string, billId: string, lock: boolean): Promise<ClearingFacts> {
  const facts: ClearingFacts = { bill: null, link: null, conn: null, side: null, loan: null, cutover: null, pendingCents: 0 };
  facts.bill = await readBill(companyId, billId, lock);
  if (!facts.bill) return facts;
  const found = await readLink(companyId, billId, false);
  if (found) {
    facts.conn = await lockConnection(companyId, found.connectionId);
    facts.side = facts.conn ? await lockPayerSide(companyId, found.connectionId) : null;
    // step 4: the link re-read under its lock, as it then stands (an unlink in flight was waited for)
    facts.link = facts.conn ? await readLink(companyId, billId, true, found.id) : null;
    if (facts.link && facts.link.connectionId !== found.connectionId) facts.link = null;
    if (facts.side?.loanAccountId) facts.loan = await lockLoanAccount(companyId, facts.side.loanAccountId);
    if (facts.conn) facts.cutover = await pairCutover(companyId, facts.conn);
  }
  facts.pendingCents = await pendingPaymentCents(companyId, billId);
  return facts;
}

/** (j).5: the receiver-readiness preflight (migration 1029, read only): one coarse word from the PARTNER's rows. */
export async function receiverReadiness(linkId: string, billId: string, amount: number): Promise<string> {
  const rows = (await sql`SELECT public.intercompany_receiver_loan_ready(${linkId}::UUID, ${billId}::UUID, ${amount}::NUMERIC) AS r`) as Row[];
  return String(rows[0]?.r ?? 'not_found');
}

/** (j).1: the allocation message(s) the P4-B hook sent for the payment's allocation rows (this company the sender). */
export async function sentMessagesFor(companyId: string, paymentId: string): Promise<Array<{ id: string; cashLeg: boolean; amount: number }>> {
  const rows = (await sql`
    SELECT m.id, (m.payload #>> '{payment,cashLegIsLoanAccount}') = 'true' AS cash_leg, (m.payload ->> 'amount')::NUMERIC AS amount
      FROM intercompany_messages m
      JOIN payment_allocations pa ON pa.id = m.source_doc_id
      JOIN supplier_payments sp ON sp.id = pa.payment_id AND sp.company_id = ${companyId}::UUID
     WHERE pa.payment_id = ${paymentId}::UUID AND m.from_company_id = ${companyId}::UUID AND m.kind = 'allocation'
       AND m.source_doc_type = 'payment_allocation'
  `) as Row[];
  return rows.map((r) => ({ id: String(r.id), cashLeg: r.cash_leg === true, amount: Number(r.amount) }));
}

/** The posted journal's lines (company-scoped), to prove the clearing is exactly DR AP / CR the loan account. */
export async function journalLinesOf(companyId: string, journalId: string): Promise<Array<{ account: string; debitCents: number; creditCents: number }>> {
  const rows = (await sql`
    SELECT l.gl_account_id, COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit
      FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id AND e.company_id = ${companyId}::UUID AND e.status = 'posted'
     WHERE l.journal_entry_id = ${journalId}::UUID AND l.company_id = ${companyId}::UUID
  `) as Row[];
  return rows.map((r) => ({ account: String(r.gl_account_id), debitCents: cents(Number(r.debit)), creditCents: cents(Number(r.credit)) }));
}

/** "code name" of an account of this company, null when it is not one. */
export async function accountLabel(companyId: string, accountId: string | null): Promise<string | null> {
  if (!accountId) return null;
  const rows = (await sql`SELECT account_code, account_name FROM gl_accounts WHERE id = ${accountId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
  return rows[0] ? `${String(rows[0].account_code)} ${String(rows[0].account_name)}` : null;
}

/** The payer's own supplier record for the partner (what these books call it). */
export async function supplierName(companyId: string, supplierId: string | null): Promise<string | null> {
  if (!supplierId) return null;
  const rows = (await sql`SELECT COALESCE(NULLIF(company_name, ''), name) AS n FROM suppliers WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
  return text(rows[0]?.n);
}
