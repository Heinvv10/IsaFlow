/**
 * Mechanism 2 of `unappliedCashService`: every posted control-account movement
 * that NO subledger document references.
 *
 * Split out of the service for the 300-line rule. The decisions are in the
 * comments below and in the service's header; this file is the SQL.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { deletedDocumentChainLinkFragment } from '../shared/softDeleteLedgerPresence';

/**
 * @returns one row per unclaimed journal: `id`, `reversal_of_id`,
 *   `document_number`, `document_date`, `created_at` and `control_credit`,
 *   BEFORE `dropCancelledReversalPairs` — the caller applies that.
 */
export async function readOrphanControlPostings(
  companyId: string,
  isAr: boolean,
  asAtDate: string,
  ids: string[],
): Promise<DbRow[]> {
  // Taken SIGNED, in the control account's own direction, and negated so it
  // reads as "what has to be added to the control balance to reach the
  // subledger". The two partitions — documents that claim a journal, journals
  // no document claims — must cover the control account exactly once each, or
  // the decomposition double-counts and the residual never reaches zero.
  //
  // A SOFT-DELETED document's reversal chain is not a reconciling item, at
  // any length. The document keeps pointing at its ORIGINAL entry O, so the
  // delete's reversal R, and any hand reversal of R and of that (R2, R3 ...),
  // pass every `NOT EXISTS` below. But the sub-ledger side already accounts
  // for that chain: it keeps the document exactly when the chain's PARITY as
  // at the date says O is standing (shared/softDeleteLedgerPresence), and
  // `unpostedDocumentService` nets the document against O alone. So the chain
  // past O nets to zero when the document is kept and to -O when it is
  // dropped, and either way it is already in the decomposition; itemising any
  // link of it re-opens a gap both sides had closed. Excluding only the entry
  // `soft_delete_journal_reversals` records did that the moment R was itself
  // reversed (D7): R2 lost its partner and became a false orphan, failing the
  // AR/AP close checks on books that tied. The chain comes from
  // shared/softDeleteLedgerPresence, which owns the parity walk, so the two can
  // never disagree about which entries are the chain.
  return (await (isAr
    ? sql`
      SELECT je.id, je.reversal_of_id, je.entry_number AS document_number,
             NULL::text AS entity_name,
             je.entry_date AS document_date, je.created_at,
             COALESCE(SUM(jl.credit - jl.debit), 0) AS control_credit
      FROM gl_journal_entries je
      JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                              AND jl.company_id = ${companyId}::UUID
                              AND jl.gl_account_id = ANY(${ids}::uuid[])
      WHERE je.company_id = ${companyId}::UUID
        AND je.status = 'posted'
        AND je.entry_date <= ${asAtDate}::DATE
        AND NOT EXISTS (SELECT 1 FROM customer_invoices d
                        WHERE d.company_id = ${companyId}::UUID AND d.gl_journal_entry_id = je.id)
        -- A CANCELLED document does not claim its journal. Cancelling posts
        -- a reversal and undoes the application, so the original and the
        -- reversal net to zero on the control account and neither relates to
        -- anything open. While the cancelled document still counted as a
        -- claimant, only the REVERSAL reached this list -- an unbalanced item
        -- on a pair that moved the control account by nothing. Letting the
        -- original through instead lets dropCancelledReversalPairs see both
        -- legs and drop them together, by the outcome rule it already
        -- applies. A cancelled document whose journal was never reversed
        -- still surfaces here, which is right: that cash is on the control
        -- account and no live document claims it.
        AND NOT EXISTS (SELECT 1 FROM customer_payments d
                        WHERE d.company_id = ${companyId}::UUID AND d.gl_journal_entry_id = je.id
                          AND COALESCE(d.status, '') <> 'cancelled')
        AND NOT EXISTS (SELECT 1 FROM credit_notes d
                        WHERE d.company_id = ${companyId}::UUID AND d.gl_journal_entry_id = je.id
                          AND COALESCE(d.status, '') <> 'cancelled')
        -- A write-off's journal IS claimed — by the write-off, and through it
        -- by the invoice (unpostedDocumentService counts it there). Leaving it
        -- out of this list reported it as a posting with no document.
        AND NOT EXISTS (SELECT 1 FROM customer_write_offs d
                        WHERE d.company_id = ${companyId}::UUID AND d.gl_journal_entry_id = je.id
                          AND COALESCE(d.status, '') <> 'cancelled')
        AND NOT ${deletedDocumentChainLinkFragment('je', companyId)}
      GROUP BY je.id, je.reversal_of_id, je.entry_number, je.entry_date, je.created_at
      HAVING COALESCE(SUM(jl.credit - jl.debit), 0) <> 0
      ORDER BY je.entry_date, je.id
    `
    : sql`
      SELECT je.id, je.reversal_of_id, je.entry_number AS document_number,
             NULL::text AS entity_name,
             je.entry_date AS document_date, je.created_at,
             COALESCE(SUM(jl.debit - jl.credit), 0) AS control_credit
      FROM gl_journal_entries je
      JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                              AND jl.company_id = ${companyId}::UUID
                              AND jl.gl_account_id = ANY(${ids}::uuid[])
      WHERE je.company_id = ${companyId}::UUID
        AND je.status = 'posted'
        AND je.entry_date <= ${asAtDate}::DATE
        AND NOT EXISTS (SELECT 1 FROM supplier_invoices d
                        WHERE d.company_id = ${companyId}::UUID AND d.gl_journal_entry_id = je.id)
        -- See the note on the AR query above: a CANCELLED document does not
        -- claim its journal, so the original joins its reversal here and the
        -- pair is dropped together.
        AND NOT EXISTS (SELECT 1 FROM supplier_payments d
                        WHERE d.company_id = ${companyId}::UUID AND d.gl_journal_entry_id = je.id
                          AND COALESCE(d.status, '') <> 'cancelled')
        AND NOT EXISTS (SELECT 1 FROM credit_notes d
                        WHERE d.company_id = ${companyId}::UUID AND d.gl_journal_entry_id = je.id
                          AND COALESCE(d.status, '') <> 'cancelled')
        AND NOT ${deletedDocumentChainLinkFragment('je', companyId)}
      GROUP BY je.id, je.reversal_of_id, je.entry_number, je.entry_date, je.created_at
      HAVING COALESCE(SUM(jl.debit - jl.credit), 0) <> 0
      ORDER BY je.entry_date, je.id
    `)) as DbRow[];
}
