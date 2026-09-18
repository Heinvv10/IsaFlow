/**
 * The two document-scan queries behind `unpostedDocumentService`.
 *
 * Split out for the 300-line rule. The decisions live in the service's header
 * and in the comments here; this file is the SQL.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { effectivePaidExpr, rewindAmount } from '../shared/agingRewind';
import { documentInPopulationExpr } from '../shared/documentPopulation';

export interface UnpostedQueryArgs {
  companyId: string;
  asAtDate: string;
  todayStr: string;
  /** Every resolved control account id. */
  ids: string[];
}

/**
 * @returns one row per document: `balance`, `has_journal` and `control_amount`,
 *   the last being what the document's own journal and the payments, credit
 *   notes and write-offs attached to it put on a control account.
 */
export async function readUnpostedDocumentRows(
  isAr: boolean,
  { companyId, asAtDate, todayStr, ids }: UnpostedQueryArgs,
): Promise<DbRow[]> {
  const paid = effectivePaidExpr(isAr ? 'ar' : 'ap');
  // The status half is the shared rule, NOT a re-typed copy: the bare spelling
  // here drifted from the subledger's in R-059 round 5 and turned a null-status
  // document into a false document_not_on_control_account item plus an equal
  // and opposite unexplained_difference on books that tied.
  const inPopulation = isAr
    ? `${documentInPopulationExpr('ci')} AND COALESCE(ci.invoice_date, ci.created_at::date) <= `
    : `${documentInPopulationExpr('si')} AND COALESCE(si.invoice_date, si.created_at::date) <= `;

  // AR and AP are SEPARATE queries, not one query branching on a boolean
  // parameter: that form type-checked, ran without error and returned nothing
  // on data where a manual join found the rows.
  const rows = (await (isAr
    ? sql`
      SELECT ci.id, ci.invoice_number AS document_number, c.name AS entity_name,
             ci.invoice_date AS document_date, ci.total_amount AS gross,
             CASE WHEN ${sql.unsafe(inPopulation)} ${asAtDate}::DATE
                        AND (ci.total_amount - ${sql.unsafe(paid)}) > 0
                  THEN (ci.total_amount - ${sql.unsafe(paid)}) ELSE 0 END AS balance,
             (ci.gl_journal_entry_id IS NOT NULL) AS has_journal,
             COALESCE((
               SELECT SUM(jl.debit - jl.credit)
               FROM gl_journal_lines jl
               JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
                                         AND je.company_id = ${companyId}::UUID
                                         AND je.status = 'posted'
                                         AND je.entry_date <= ${asAtDate}::DATE
               WHERE jl.journal_entry_id = ci.gl_journal_entry_id
                 AND jl.company_id = ${companyId}::UUID
                 AND jl.gl_account_id = ANY(${ids}::uuid[])
             ), 0)
             -- THE ALLOCATED AMOUNT, not the whole journal. A payment's
             -- control movement splits between the documents it was allocated
             -- to and the remainder the unapplied-cash item claims, so summing
             -- the journal's lines per allocation row gives an invoice the
             -- WHOLE payment: a R100 receipt with R99.99 applied relieved the
             -- invoice by R100 while the unapplied item also claimed R0.01,
             -- and the cent was counted twice. Two allocations from one
             -- payment to one invoice doubled it outright. The cap matches
             -- the one in unappliedPaymentCash: attributions cannot exceed
             -- the cash that actually reached the control account.
             - LEAST(
                 COALESCE((
                   SELECT SUM(a.amount_allocated)
                   FROM customer_payment_allocations a
                   WHERE a.invoice_id = ci.id
                     AND EXISTS (
                       SELECT 1 FROM customer_payments p
                       JOIN gl_journal_entries je ON je.id = p.gl_journal_entry_id
                                                 AND je.company_id = ${companyId}::UUID
                                                 AND je.status = 'posted'
                                                 AND je.entry_date <= ${asAtDate}::DATE
                       WHERE p.id = a.payment_id AND p.company_id = ${companyId}::UUID
                         AND COALESCE(p.status, '') <> 'cancelled'
                     )
                 ), 0),
                 COALESCE((
                   SELECT SUM(jl.credit - jl.debit)
                   FROM customer_payment_allocations a
                   JOIN customer_payments p ON p.id = a.payment_id
                                           AND p.company_id = ${companyId}::UUID
                                           AND COALESCE(p.status, '') <> 'cancelled'
                   JOIN gl_journal_entries je ON je.id = p.gl_journal_entry_id
                                             AND je.company_id = ${companyId}::UUID
                                             AND je.status = 'posted'
                                             AND je.entry_date <= ${asAtDate}::DATE
                   JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                                           AND jl.company_id = ${companyId}::UUID
                                           AND jl.gl_account_id = ANY(${ids}::uuid[])
                   WHERE a.invoice_id = ci.id
                 ), 0)
               )
             -- THE APPLIED AMOUNT, not the whole journal, and never a
             -- cancelled note. A linked note is consumed by the document only
             -- to the extent of its applied_amount (mig 529); the rest is
             -- credit no document has taken up and belongs to the
             -- unapplied_credit_note item, which counts it from the other
             -- side. Counting the whole journal here put that remainder in
             -- both places: on a production copy, 12 bills each carried one
             -- applied and one approved note of the same value, and R5,740.22
             -- was claimed twice. Cancelling REVERSES the note's journal, so a
             -- cancelled note relieves nothing at all.
             - LEAST(
                 COALESCE((
                   SELECT SUM(cn.applied_amount)
                   FROM credit_notes cn
                   WHERE cn.company_id = ${companyId}::UUID
                     AND cn.customer_invoice_id = ci.id
                     AND COALESCE(cn.status, '') <> 'cancelled'
                     AND EXISTS (
                       SELECT 1 FROM gl_journal_entries je
                       WHERE je.id = cn.gl_journal_entry_id
                         AND je.company_id = ${companyId}::UUID
                         AND je.status = 'posted'
                         AND je.entry_date <= ${asAtDate}::DATE
                     )
                 ), 0),
                 COALESCE((
                   SELECT SUM(jl.credit - jl.debit)
                   FROM credit_notes cn
                   JOIN gl_journal_entries je ON je.id = cn.gl_journal_entry_id
                                             AND je.company_id = ${companyId}::UUID
                                             AND je.status = 'posted'
                                             AND je.entry_date <= ${asAtDate}::DATE
                   JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                                           AND jl.company_id = ${companyId}::UUID
                                           AND jl.gl_account_id = ANY(${ids}::uuid[])
                   WHERE cn.company_id = ${companyId}::UUID
                     AND cn.customer_invoice_id = ci.id
                     AND COALESCE(cn.status, '') <> 'cancelled'
                 ), 0)
               )
             -- The write-off leg. approveWriteOff raises amount_paid AND
             -- credits the control account, so without its journal here a
             -- written-off invoice read as "not on the control account" by
             -- the write-off, and unappliedCashService read the same journal
             -- as a posting with no document: two false items netting to
             -- nothing. Pre-existing on master; measured in R-059 round 6.
             + COALESCE((
               SELECT SUM(jl.debit - jl.credit)
               FROM customer_write_offs wo
               JOIN gl_journal_entries je ON je.id = wo.gl_journal_entry_id
                                         AND je.company_id = ${companyId}::UUID
                                         AND je.status = 'posted'
                                         AND je.entry_date <= ${asAtDate}::DATE
               JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                                       AND jl.company_id = ${companyId}::UUID
                                       AND jl.gl_account_id = ANY(${ids}::uuid[])
               WHERE wo.company_id = ${companyId}::UUID
                 AND wo.invoice_id = ci.id
                 AND COALESCE(wo.status, '') <> 'cancelled'
             ), 0) AS control_amount
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
                           AND c.company_id = ${companyId}::UUID
      LEFT JOIN LATERAL (
        ${rewindAmount({ companyId, asAtStr: asAtDate, todayStr, side: 'ar' })}
      ) unpaid ON TRUE
      WHERE ci.company_id = ${companyId}::UUID
      ORDER BY ci.invoice_date, ci.id
    `
    : sql`
      SELECT si.id, si.invoice_number AS document_number, s.name AS entity_name,
             si.invoice_date AS document_date, si.total_amount AS gross,
             CASE WHEN ${sql.unsafe(inPopulation)} ${asAtDate}::DATE
                        AND (si.total_amount - ${sql.unsafe(paid)}) > 0
                  THEN (si.total_amount - ${sql.unsafe(paid)}) ELSE 0 END AS balance,
             (si.gl_journal_entry_id IS NOT NULL) AS has_journal,
             COALESCE((
               SELECT SUM(jl.credit - jl.debit)
               FROM gl_journal_lines jl
               JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
                                         AND je.company_id = ${companyId}::UUID
                                         AND je.status = 'posted'
                                         AND je.entry_date <= ${asAtDate}::DATE
               WHERE jl.journal_entry_id = si.gl_journal_entry_id
                 AND jl.company_id = ${companyId}::UUID
                 AND jl.gl_account_id = ANY(${ids}::uuid[])
             ), 0)
             -- THE ALLOCATED AMOUNT, not the whole journal -- the mirror of
             -- the AR note above. Summing the journal per allocation row
             -- relieves a bill by the payment's FULL value however little was
             -- applied to it, and the unapplied item claims the remainder as
             -- well.
             - LEAST(
                 COALESCE((
                   SELECT SUM(a.amount_allocated)
                   FROM payment_allocations a
                   WHERE a.invoice_id = si.id
                     AND EXISTS (
                       SELECT 1 FROM supplier_payments p
                       JOIN gl_journal_entries je ON je.id = p.gl_journal_entry_id
                                                 AND je.company_id = ${companyId}::UUID
                                                 AND je.status = 'posted'
                                                 AND je.entry_date <= ${asAtDate}::DATE
                       WHERE p.id = a.payment_id AND p.company_id = ${companyId}::UUID
                         AND COALESCE(p.status, '') <> 'cancelled'
                     )
                 ), 0),
                 COALESCE((
                   SELECT SUM(jl.debit - jl.credit)
                   FROM payment_allocations a
                   JOIN supplier_payments p ON p.id = a.payment_id
                                           AND p.company_id = ${companyId}::UUID
                                           AND COALESCE(p.status, '') <> 'cancelled'
                   JOIN gl_journal_entries je ON je.id = p.gl_journal_entry_id
                                             AND je.company_id = ${companyId}::UUID
                                             AND je.status = 'posted'
                                             AND je.entry_date <= ${asAtDate}::DATE
                   JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                                           AND jl.company_id = ${companyId}::UUID
                                           AND jl.gl_account_id = ANY(${ids}::uuid[])
                   WHERE a.invoice_id = si.id
                 ), 0)
               )
             -- The credit-note leg, the mirror of the AR one above. A linked
             -- supplier credit note raises the bill's amount_paid AND debits
             -- the control account; the AR side counted it and this side did
             -- not, so every credit-noted bill read as "not on the control
             -- account" by the note and the same amount fell into
             -- unexplained_difference. Pre-existing on master; R-059 round 6.
             -- THE APPLIED AMOUNT, never the whole journal and never a
             -- cancelled note -- the mirror of the AR leg above.
             - LEAST(
                 COALESCE((
                   SELECT SUM(cn.applied_amount)
                   FROM credit_notes cn
                   WHERE cn.company_id = ${companyId}::UUID
                     AND cn.supplier_invoice_id = si.id
                     AND COALESCE(cn.status, '') <> 'cancelled'
                     AND EXISTS (
                       SELECT 1 FROM gl_journal_entries je
                       WHERE je.id = cn.gl_journal_entry_id
                         AND je.company_id = ${companyId}::UUID
                         AND je.status = 'posted'
                         AND je.entry_date <= ${asAtDate}::DATE
                     )
                 ), 0),
                 COALESCE((
                   SELECT SUM(jl.debit - jl.credit)
                   FROM credit_notes cn
                   JOIN gl_journal_entries je ON je.id = cn.gl_journal_entry_id
                                             AND je.company_id = ${companyId}::UUID
                                             AND je.status = 'posted'
                                             AND je.entry_date <= ${asAtDate}::DATE
                   JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                                           AND jl.company_id = ${companyId}::UUID
                                           AND jl.gl_account_id = ANY(${ids}::uuid[])
                   WHERE cn.company_id = ${companyId}::UUID
                     AND cn.supplier_invoice_id = si.id
                     AND COALESCE(cn.status, '') <> 'cancelled'
                 ), 0)
               ) AS control_amount
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = ${companyId}::UUID
      LEFT JOIN LATERAL (
        ${rewindAmount({ companyId, asAtStr: asAtDate, todayStr, side: 'ap' })}
      ) unpaid ON TRUE
      WHERE si.company_id = ${companyId}::UUID
      ORDER BY si.invoice_date, si.id
    `)) as DbRow[];
  return rows;
}
