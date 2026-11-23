/**
 * The RECEIVER's reads and row locks for clearing an allocation message (P4-D), each its own statement on the request's transaction (RLS limits
 * every row to the session company, which each query names too). THE LOCK ORDER is the clearing's and no other exists (plan (i).8):
 *   1. the message FOR UPDATE, with every other allocation message to this company from the same payer naming the same payer payment or the
 *      same payer journal (one statement, ascending id): two accepts of messages that share a cap wait for each other instead of both passing it;
 *   1b. the payer's advisory locks (its payment, journal and bill: `intercompany_allocation_cap_lock`, ascending key), so a clearing by ANOTHER
 *      receiver of the same payer waits too (the guard takes them again, re-entrant);
 *   2. the connection FOR SHARE;  3. this company's side FOR SHARE;  4. the payload's link FOR SHARE;
 *   5. the invoice FOR UPDATE (`lockReceiptInvoices`, the receipts' own bounded lock);  6. the loan account FOR SHARE;
 *   then what the composed services lock themselves (the new payment, the fiscal period, the VAT advisory key).
 */
import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;
const text = (v: unknown): string | null => (v == null ? null : String(v));

export interface LockedMessage {
  id: string;
  status: string;
  fromCompanyId: string;
  connectionId: string;
  payload: unknown;
  sourceJournalEntryId: string | null;
}

/** Step 1: the message and its cap siblings, locked in id order; the message itself, or null when it is not this company's allocation message. */
export async function lockAllocationMessages(companyId: string, messageId: string): Promise<LockedMessage | null> {
  const rows = (await sql`
    WITH me AS (
      SELECT m.from_company_id, m.payload #>> '{payment,id}' AS payment, m.source_journal_entry_id AS je
        FROM intercompany_messages m
       WHERE m.id = ${messageId}::UUID AND m.to_company_id = ${companyId}::UUID AND m.kind = 'allocation'
    )
    SELECT x.id, x.status, x.from_company_id, x.connection_id, x.payload, x.source_journal_entry_id
      FROM intercompany_messages x, me
     WHERE x.to_company_id = ${companyId}::UUID AND x.kind = 'allocation' AND x.from_company_id = me.from_company_id
       AND (x.id = ${messageId}::UUID OR (x.payload #>> '{payment,id}') = me.payment OR x.source_journal_entry_id = me.je)
     ORDER BY x.id
       FOR UPDATE OF x
  `) as Row[];
  const r = rows.find((x) => String(x.id) === messageId);
  if (!r) return null;
  return {
    id: String(r.id), status: String(r.status), fromCompanyId: String(r.from_company_id), connectionId: String(r.connection_id),
    payload: r.payload, sourceJournalEntryId: text(r.source_journal_entry_id),
  };
}

export interface LockedConnection { id: string; status: string; kind: string; settlementMode: string | null; cutoverDate: string | null; lowId: string; highId: string }

/** Step 2. */
export async function lockConnection(companyId: string, connectionId: string): Promise<LockedConnection | null> {
  const rows = (await sql`
    SELECT c.id, c.status, c.kind, c.settlement_mode, to_char(c.cutover_date, 'YYYY-MM-DD') AS cutover, c.company_low_id, c.company_high_id
      FROM intercompany_connections c
     WHERE c.id = ${connectionId}::UUID AND (c.company_low_id = ${companyId}::UUID OR c.company_high_id = ${companyId}::UUID)
       FOR SHARE
  `) as Row[];
  const r = rows[0];
  return r ? {
    id: String(r.id), status: String(r.status), kind: String(r.kind), settlementMode: text(r.settlement_mode), cutoverDate: text(r.cutover),
    lowId: String(r.company_low_id), highId: String(r.company_high_id),
  } : null;
}

/** Step 3: this company's own side (the loan account it clears against, the payer's customer account). */
export async function lockOwnSide(companyId: string, connectionId: string): Promise<{ loanAccountId: string | null; customerId: string | null } | null> {
  const rows = (await sql`
    SELECT s.loan_account_id, s.customer_id FROM intercompany_connection_sides s
     WHERE s.connection_id = ${connectionId}::UUID AND s.company_id = ${companyId}::UUID
       FOR SHARE
  `) as Row[];
  return rows[0] ? { loanAccountId: text(rows[0].loan_account_id), customerId: text(rows[0].customer_id) } : null;
}

/** Step 4: the payload's link, held so an unlink waits for this transaction (the liveness answer judges it as it then stands). */
export async function lockLink(companyId: string, linkId: string, connectionId: string): Promise<void> {
  await sql`
    SELECT k.id FROM intercompany_document_links k
     WHERE k.id = ${linkId}::UUID AND k.connection_id = ${connectionId}::UUID
       AND (k.company_a_id = ${companyId}::UUID OR k.company_b_id = ${companyId}::UUID)
       FOR SHARE
  `;
}

/** Step 5's other facts (the row is already locked by `lockReceiptInvoices`). */
export async function invoiceFacts(companyId: string, invoiceId: string): Promise<{ date: string | null; customerId: string | null; currency: string } | null> {
  const rows = (await sql`
    SELECT to_char(ci.invoice_date, 'YYYY-MM-DD') AS date, COALESCE(ci.client_id, ci.customer_id) AS customer,
           upper(COALESCE(NULLIF(ci.currency_code, ''), 'ZAR')) AS currency
      FROM customer_invoices ci WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
  `) as Row[];
  return rows[0] ? { date: text(rows[0].date), customerId: text(rows[0].customer), currency: String(rows[0].currency) } : null;
}

export interface LockedAccount { accountType: string | null; accountSubtype: string | null; isActive: boolean; isParent: boolean; isSystem: boolean }

/** Step 6: the loan account, held so it cannot be re-typed, deactivated or re-parented under the clearing. */
export async function lockLoanAccount(companyId: string, accountId: string): Promise<LockedAccount | null> {
  const rows = (await sql`
    SELECT ga.account_type, ga.account_subtype, ga.is_active, ga.is_system_account,
           EXISTS (SELECT 1 FROM gl_accounts child WHERE child.parent_account_id = ga.id AND child.company_id = ga.company_id) AS is_parent
      FROM gl_accounts ga WHERE ga.id = ${accountId}::UUID AND ga.company_id = ${companyId}::UUID
       FOR SHARE OF ga
  `) as Row[];
  const r = rows[0];
  return r ? { accountType: text(r.account_type), accountSubtype: text(r.account_subtype), isActive: r.is_active !== false, isParent: r.is_parent === true, isSystem: r.is_system_account === true } : null;
}

export interface LiveAnswer { live: boolean; reason: string; cap: string | null; payerLoanType: string | null }

/** The database's answer, asked under the locks above (1027: the caps across every receiver, and the payer's loan type). Exactly one row, or a
 *  throw: the clearing never goes on a defaulted answer. */
export async function askLive(messageId: string): Promise<LiveAnswer> {
  const rows = (await sql`
    SELECT live, reason, cap, payer_loan_type FROM public.intercompany_allocation_message_live(${messageId}::UUID)
  `) as Row[];
  if (rows.length !== 1) throw new Error('the allocation liveness check did not answer exactly one row');
  const r = rows[0]!;
  return { live: r.live === true, reason: String(r.reason), cap: text(r.cap), payerLoanType: text(r.payer_loan_type) };
}

/** Step 1b, right after the message lock: the payer's payment / journal / bill advisory locks (every receiver's clearing of them waits). */
export async function lockPayerCaps(messageId: string): Promise<void> {
  await sql`SELECT public.intercompany_allocation_cap_lock(${messageId}::UUID)`;
}

/** What draft receipts of this company already claim on the invoice (as `createCustomerPayment` counts them). */
export async function pendingDraftAmount(companyId: string, invoiceId: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(cpa.amount_allocated), 0) AS pending
      FROM customer_payment_allocations cpa JOIN customer_payments cp ON cp.id = cpa.payment_id
     WHERE cpa.invoice_id = ${invoiceId}::UUID AND cp.company_id = ${companyId}::UUID AND cp.status = 'draft'
  `) as Row[];
  return Number(rows[0]?.pending ?? 0);
}

/**
 * The pair's cut-over, the rule the mirror and the eliminations use (`intercompany_pair_cutovers`, 1019): the latest of the connection's
 * cut-over date and both sides' `mirroring_since` (Johannesburg), for a GROUP connection whose two sides both mirror, in the group the pair's
 * mirrors go to. Null when the pair has none (an external connection, a side not mirroring, no cut-over date): the clearing then refuses.
 */
export async function pairCutover(companyId: string, conn: LockedConnection): Promise<string | null> {
  if (conn.kind !== 'group' || !conn.cutoverDate) return null;
  // asked of each current group of this company (the only memberships it can read); the definer answers only for the pair's mirror group
  const rows = (await sql`
    SELECT to_char(pc.cutover, 'YYYY-MM-DD') AS cutover
      FROM company_group_members gm
      CROSS JOIN LATERAL public.intercompany_pair_cutovers(gm.group_id) pc
     WHERE gm.company_id = ${companyId}::UUID AND gm.left_date IS NULL
       AND pc.company_low_id = ${conn.lowId}::UUID AND pc.company_high_id = ${conn.highId}::UUID
     LIMIT 1
  `) as Row[];
  return text(rows[0]?.cutover);
}

/** The session user may write intercompany rows of this company (the guard's own question, asked first so a refusal is a 403, not a 500). */
export async function userCanWrite(companyId: string): Promise<boolean> {
  const rows = (await sql`SELECT public.intercompany_user_can_write(${companyId}::UUID) AS ok`) as Row[];
  return rows[0]?.ok === true;
}
