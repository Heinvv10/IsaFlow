/**
 * Continuous Close API
 * POST /api/accounting/continuous-close
 * Body: { action: 'run' | 'status' }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  planCloseActions,
  summarizeCloseRun,
  prioritizeExceptions,
  type CloseRunResults,
} from '@/modules/accounting/services/gl/continuousCloseService';
import { buildCloseState } from '@/modules/accounting/services/gl/continuousCloseQueryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);

  const { companyId } = req as CompanyAuthedRequest;
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

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
