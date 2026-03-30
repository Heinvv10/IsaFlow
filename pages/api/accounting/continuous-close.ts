/**
 * Continuous Close API
 * POST /api/accounting/continuous-close
 * Body: { action: 'run' | 'status' }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  planCloseActions,
  summarizeCloseRun,
  prioritizeExceptions,
  type CloseState,
  type CloseRunResults,
} from '@/modules/accounting/services/continuousCloseService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function buildCloseState(companyId: string): Promise<CloseState> {
  // Uncategorized bank transactions (no GL account mapped)
  const uncategorizedRows = (await sql`
    SELECT bt.id, bt.description, bt.amount::float AS amount
    FROM bank_transactions bt
    WHERE bt.company_id = ${companyId}
      AND bt.gl_account_id IS NULL
      AND bt.status = 'pending'
    ORDER BY bt.transaction_date DESC
    LIMIT 100
  `) as Row[];

  // Unmatched bank transactions (no matched invoice/payment)
  const unmatchedRows = (await sql`
    SELECT bt.id, bt.amount::float AS amount, COALESCE(bt.reference, bt.description) AS reference
    FROM bank_transactions bt
    WHERE bt.company_id = ${companyId}
      AND bt.matched = false
      AND bt.status = 'pending'
    ORDER BY bt.transaction_date DESC
    LIMIT 100
  `) as Row[];

  // Pending customer invoices (draft/unpaid with high auto-approval confidence)
  const pendingInvoiceRows = (await sql`
    SELECT
      ci.id,
      ci.total_amount::float AS amount,
      0.9 AS confidence
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

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);

  const { companyId } = req as CompanyApiRequest;
  const { action } = req.body as { action?: string };

  if (!action || !['run', 'status'].includes(action)) {
    return apiResponse.badRequest(res, "action must be 'run' or 'status'");
  }

  log.info('continuous-close: starting', { companyId, action });

  const state = await buildCloseState(companyId);

  if (action === 'status') {
    const plan = planCloseActions(state);
    const exceptions = prioritizeExceptions(plan.step5_exceptions);

    log.info('continuous-close: status complete', { companyId, uncategorized: state.uncategorizedTxCount, unmatched: state.unmatchedTxCount });

    return apiResponse.success(res, {
      state: {
        uncategorizedTxCount: state.uncategorizedTxCount,
        unmatchedTxCount: state.unmatchedTxCount,
        pendingInvoiceCount: state.pendingInvoiceCount,
        pendingJournalCount: state.pendingJournalCount,
      },
      plan: {
        toCategorizeTxs: plan.step1_categorize.length,
        toMatchTxs: plan.step2_match.length,
        toApproveInvoices: plan.step3_approve.length,
        toPostJournals: plan.step4_post.length,
        exceptions: exceptions.length,
      },
      exceptions,
    });
  }

  // action === 'run': simulate close run based on plan
  const startMs = Date.now();
  const plan = planCloseActions(state);

  const results: CloseRunResults = {
    categorized: plan.step1_categorize.length,
    matched: plan.step2_match.length,
    approved: plan.step3_approve.length,
    posted: plan.step4_post.length,
    exceptions: plan.step5_exceptions,
  };

  const durationMs = Date.now() - startMs;
  const summary = summarizeCloseRun(results, durationMs);
  const prioritizedExceptions = prioritizeExceptions(results.exceptions);

  log.info('continuous-close: run complete', { companyId, ...summary });

  return apiResponse.success(res, {
    summary,
    results: {
      categorized: results.categorized,
      matched: results.matched,
      approved: results.approved,
      posted: results.posted,
    },
    exceptions: prioritizedExceptions,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
