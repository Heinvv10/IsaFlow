/**
 * Continuous Close — data access.
 *
 * Reads the four work queues the close agent plans over. Pure reads; all
 * planning lives in continuousCloseService.ts.
 */

import { sql } from '@/lib/neon';
import type { CloseState } from './continuousCloseService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export async function buildCloseState(companyId: string): Promise<CloseState> {
  // Uncategorized: still awaiting work and without even a suggested GL account.
  // Same definition monthEndWorkbenchService uses for its "unsuggested" count.
  const uncategorizedRows = (await sql`
    SELECT bt.id, bt.description, bt.amount::float AS amount
    FROM bank_transactions bt
    WHERE bt.company_id = ${companyId}
      AND bt.status = 'imported'
      AND bt.suggested_gl_account_id IS NULL
    ORDER BY bt.transaction_date DESC
    LIMIT 100
  `) as Row[];

  // Unmatched: not yet allocated, matched or reconciled. 'imported' is the
  // same definition bankReconciliationService uses for its unmatched_count.
  const unmatchedRows = (await sql`
    SELECT bt.id, bt.amount::float AS amount, COALESCE(bt.reference, bt.description) AS reference
    FROM bank_transactions bt
    WHERE bt.company_id = ${companyId}
      AND bt.status = 'imported'
    ORDER BY bt.transaction_date DESC
    LIMIT 100
  `) as Row[];

  // Pending customer invoices — confidence based on data completeness.
  // Weights sum to 1.0 so a fully populated draft scores exactly 1. There is
  // deliberately no term for the customer: `customer_id` is NOT NULL on both
  // dev and production, so it would add a constant and measure nothing.
  const pendingInvoiceRows = (await sql`
    SELECT
      ci.id,
      ci.total_amount::float AS amount,
      (
        CASE WHEN ci.total_amount > 0 THEN 0.3 ELSE 0 END +
        CASE WHEN ci.invoice_date IS NOT NULL THEN 0.2 ELSE 0 END +
        CASE WHEN ci.due_date IS NOT NULL THEN 0.2 ELSE 0 END +
        CASE WHEN EXISTS (SELECT 1 FROM customer_invoice_items cii WHERE cii.invoice_id = ci.id) THEN 0.3 ELSE 0 END
      )::float AS confidence
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}
      AND ci.status = 'draft'
    ORDER BY ci.invoice_date DESC
    LIMIT 50
  `) as Row[];

  // Draft journal entries
  const pendingJournalRows = (await sql`
    SELECT id, status
    FROM gl_journal_entries
    WHERE company_id = ${companyId}
      AND status = 'draft'
    ORDER BY created_at DESC
    LIMIT 50
  `) as Row[];

  return {
    uncategorizedTxCount: uncategorizedRows.length,
    unmatchedTxCount: unmatchedRows.length,
    pendingInvoiceCount: pendingInvoiceRows.length,
    pendingJournalCount: pendingJournalRows.length,
    uncategorizedTransactions: uncategorizedRows.map(r => ({
      id: r.id as string,
      description: r.description as string,
      amount: r.amount as number,
    })),
    unmatchedTransactions: unmatchedRows.map(r => ({
      id: r.id as string,
      amount: r.amount as number,
      reference: r.reference as string,
    })),
    pendingInvoices: pendingInvoiceRows.map(r => ({
      id: r.id as string,
      amount: r.amount as number,
      confidence: r.confidence as number,
    })),
    pendingJournals: pendingJournalRows.map(r => ({
      id: r.id as string,
      status: r.status as string,
    })),
  };
}
