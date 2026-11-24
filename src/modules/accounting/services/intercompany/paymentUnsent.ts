/**
 * The PAYER's "paid, no payment message" read (intercompany F, plan (k) M-4, (l) LOW-4): its processed / reconciled cash applied to a bill of
 * the partner's supplier on an ACTIVE CASH group connection, the bill in an ACTIVE link to the partner's customer invoice, dated on or after
 * the connection's cut-over, that carries NO message of either kind (the flag was off at send, a lock timeout, a definer refusal). Read only,
 * over the payer's OWN rows (its payments, allocations, bills, sides, links, its own messages); 500 rows, oldest first. A session that cannot
 * see a current group membership of its company cannot judge a group connection: `cannot_determine`, never an empty list. Not P5's report:
 * P5 is loan-only and refuses a cash connection by design.
 *
 * Round 1 (B5): ONLY what D1 (intercompany_send_for_payment) could still send, so the list carries no permanent noise: never a contra set-off
 * or a journal crediting no money account (`not_cash`), never a journal crediting the side's loan account (`through_loan`), never a reversed
 * journal (stricter than D1's odd chain: app_user cannot ask the chain, so a reversal of a reversal is left out), never a supplier on more
 * than one active cash connection (`ambiguous`), never a payment an accepted message of which lost its allocation row (`superseded`). What
 * stays is a payment the flag (off at send), a lock timeout or a since-fixed refusal left without its message.
 */
import { sql } from '@/lib/neon';
import { CASH_SUBTYPES } from '../gl/accountSubtypes';
import type { UnsentPage } from './paymentInboxTypes';

type Row = Record<string, unknown>;
export const UNSENT_LIMIT = 500;
export const CANNOT_DETERMINE = 'This company is not a current member of a group you can see, so its intercompany payments cannot be checked here.';

export async function listUnsentPayments(companyId: string): Promise<UnsentPage> {
  const [g] = (await sql`
    SELECT EXISTS (SELECT 1 FROM company_group_members gm WHERE gm.company_id = ${companyId}::UUID AND gm.left_date IS NULL) AS member,
           EXISTS (SELECT 1 FROM intercompany_connections c WHERE (c.company_low_id = ${companyId}::UUID OR c.company_high_id = ${companyId}::UUID)
                      AND c.kind = 'group' AND c.status = 'active' AND c.settlement_mode = 'cash') AS cash
  `) as Row[];
  if (g?.cash === true && g.member !== true) return { state: 'cannot_determine', sentence: CANNOT_DETERMINE, items: [] };
  const rows = (await sql`
    SELECT pa.id AS allocation_id, sp.id AS payment_id, sp.payment_number, to_char(sp.payment_date, 'YYYY-MM-DD') AS payment_date,
           si.id AS bill_id, si.invoice_number AS bill_number, pa.amount_allocated::float8 AS amount, su.name AS partner_name
      FROM payment_allocations pa
      JOIN supplier_payments sp ON sp.id = pa.payment_id AND sp.company_id = ${companyId}::UUID AND sp.status IN ('processed', 'reconciled')
      JOIN supplier_invoices si ON si.id = pa.invoice_id AND si.company_id = ${companyId}::UUID AND si.deleted_at IS NULL
      JOIN intercompany_connection_sides s ON s.company_id = ${companyId}::UUID AND s.supplier_id = si.supplier_id
      JOIN intercompany_connections c ON c.id = s.connection_id AND c.status = 'active' AND c.kind = 'group' AND c.settlement_mode = 'cash'
       AND c.cutover_date IS NOT NULL AND sp.payment_date >= c.cutover_date
      JOIN intercompany_document_links k ON k.connection_id = c.id AND k.status = 'active'
       AND ((k.company_a_id = ${companyId}::UUID AND k.doc_a_type = 'supplier_invoice' AND k.doc_a_id = si.id AND k.doc_b_type = 'customer_invoice')
         OR (k.company_b_id = ${companyId}::UUID AND k.doc_b_type = 'supplier_invoice' AND k.doc_b_id = si.id AND k.doc_a_type = 'customer_invoice'))
      LEFT JOIN suppliers su ON su.id = si.supplier_id AND su.company_id = ${companyId}::UUID
      CROSS JOIN LATERAL (SELECT COALESCE(sp.gl_journal_entry_id, (SELECT b.gl_journal_entry_id FROM supplier_payment_batches b
                                                                   WHERE b.id = sp.batch_id AND b.company_id = ${companyId}::UUID)) AS id) je
     WHERE je.id IS NOT NULL AND sp.payment_method IS DISTINCT FROM 'contra'
       AND EXISTS (SELECT 1 FROM gl_journal_entries e WHERE e.id = je.id AND e.company_id = ${companyId}::UUID AND e.status = 'posted')
       AND NOT EXISTS (SELECT 1 FROM gl_journal_entries rv WHERE rv.reversal_of_id = je.id AND rv.company_id = ${companyId}::UUID)
       AND EXISTS (SELECT 1 FROM gl_journal_lines jl JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
                    WHERE jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID AND jl.credit > 0
                      AND (ga.account_subtype = ANY(${CASH_SUBTYPES as string[]}::TEXT[])
                           OR EXISTS (SELECT 1 FROM bank_transactions bt WHERE bt.bank_account_id = ga.id AND bt.company_id = ${companyId}::UUID)))
       AND NOT EXISTS (SELECT 1 FROM gl_journal_lines jl WHERE jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID AND jl.credit > 0
                        AND jl.gl_account_id = s.loan_account_id)
       AND NOT EXISTS (SELECT 1 FROM intercompany_connection_sides s2
                         JOIN intercompany_connections c2 ON c2.id = s2.connection_id AND c2.status = 'active' AND c2.settlement_mode = 'cash'
                        WHERE s2.company_id = ${companyId}::UUID AND s2.supplier_id = si.supplier_id AND s2.connection_id <> s.connection_id)
       AND NOT EXISTS (SELECT 1 FROM intercompany_messages x
                        WHERE x.from_company_id = ${companyId}::UUID AND x.kind IN ('allocation', 'payment') AND x.status = 'accepted'
                          AND x.source_doc_type = 'payment_allocation' AND (x.payload #>> '{payment,id}') = sp.id::TEXT
                          AND NOT EXISTS (SELECT 1 FROM payment_allocations gone WHERE gone.id = x.source_doc_id))
       AND NOT EXISTS (SELECT 1 FROM intercompany_messages m
                        WHERE m.from_company_id = ${companyId}::UUID AND m.source_doc_type = 'payment_allocation' AND m.source_doc_id = pa.id
                          AND m.kind IN ('allocation', 'payment'))
     ORDER BY sp.payment_date, pa.id
     LIMIT ${UNSENT_LIMIT}
  `) as Row[];
  return {
    state: 'ok', sentence: null,
    items: rows.map((r) => ({
      allocationId: String(r.allocation_id), paymentId: String(r.payment_id), paymentNumber: r.payment_number ? String(r.payment_number) : null,
      paymentDate: String(r.payment_date), billId: String(r.bill_id), billNumber: r.bill_number ? String(r.bill_number) : null,
      amount: Number(r.amount), partnerName: String(r.partner_name ?? 'Partner'),
    })),
  };
}
