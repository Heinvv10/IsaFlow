/**
 * Smart Categorization API
 * GET  — get suggestions for a single transaction
 * POST — bulk categorize transactions or learn from allocation
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { checkAiRateLimit } from '@/lib/rateLimit';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  categorizeBankTransaction,
  bulkCategorize,
  smartCategorizeForAccount,
  learnFromAllocation,
} from '@/modules/accounting/services/core/smartCategorizationService';
import { sweep, getAutoPostSettings } from '@/modules/accounting/services/bank/autoPostGateService';
import { sql } from '@/lib/neon';
import { runAfterCommit } from '@/lib/afterCommit';
import {
  selectResidualTxIds,
  runLlmResidualPass,
  buildRunDeps,
  MAX_LLM_CALLS_PER_RUN,
} from '@/modules/accounting/services/bank/llmCategorizationPass';
type Row = Record<string, unknown>;


async function handler(req: NextApiRequest, res: NextApiResponse) {
  const authedReq = req as CompanyAuthedRequest;
  const { companyId } = authedReq;
  const userId = authedReq.user.id;

  // ── GET: Single transaction suggestion ─────────────────────────────────────
  if (req.method === 'GET') {
    const { txId } = req.query;
    if (!txId || typeof txId !== 'string') {
      return apiResponse.badRequest(res, 'txId query parameter required');
    }

    try {
      const txRows = (await sql`
        SELECT id, description, amount, reference
        FROM bank_transactions WHERE id = ${txId}::UUID AND company_id = ${companyId}
      `) as Row[];

      if (txRows.length === 0) {
        return apiResponse.notFound(res, 'Transaction', txId);
      }

      const tx = txRows[0]!;
      const result = await categorizeBankTransaction(companyId, {
        description: String(tx.description || ''),
        amount: Number(tx.amount),
        reference: tx.reference ? String(tx.reference) : undefined,
      });

      return apiResponse.success(res, {
        transactionId: txId,
        suggestion: result,
      });
    } catch (err) {
      log.error('Smart categorize GET failed', { txId, error: err }, 'accounting-api');
      return apiResponse.badRequestFromError(res, err, 'Failed');
    }
  }

  // ── POST: Bulk categorize or learn ─────────────────────────────────────────
  if (req.method === 'POST') {
    if (!(await checkAiRateLimit(req, companyId, 'smart-categorize', { companyMax: 20, dailyMax: 200 }))) {
      return apiResponse.tooManyRequests(res, 'AI request limit reached. Please slow down and try again later.');
    }

    const { action, transactionIds, bankAccountId, txId, glAccountId, category, vatCode } = req.body;

    try {
      switch (action || 'categorize') {
        case 'categorize': {
          // If bankAccountId provided, categorize all uncategorized for that account
          if (bankAccountId) {
            const result = await smartCategorizeForAccount(companyId, bankAccountId);

            // Derive affected tx ids for the residual pass
            const acctRows = (await sql`
              SELECT id FROM bank_transactions
              WHERE company_id = ${companyId}::UUID
                AND bank_account_id = ${bankAccountId}::UUID
                AND status = 'imported'
            `) as Array<{ id: string }>;
            const affectedTxIds = acctRows.map((r) => r.id);

            const candidateRows = (await sql`
              SELECT id, status,
                     suggested_gl_account_id AS "suggestedGlAccountId",
                     suggested_confidence    AS "suggestedConfidence"
              FROM bank_transactions
              WHERE id = ANY(${affectedTxIds}::uuid[])
                AND company_id = ${companyId}::UUID
            `) as Array<{ id: string; status: string; suggestedGlAccountId: string | null; suggestedConfidence: number | null }>;
            const residualIds = selectResidualTxIds(
              candidateRows.map((r) => ({
                ...r,
                suggestedConfidence: r.suggestedConfidence == null ? null : Number(r.suggestedConfidence),
              })),
              MAX_LLM_CALLS_PER_RUN,
            );
            const apSettings = await getAutoPostSettings(companyId);
            const willRunLlm = apSettings.llmEnabled && residualIds.length > 0;
            if (willRunLlm) {
              const deps = await buildRunDeps(companyId, userId, residualIds);
              // After COMMIT, off this request's connection (R-075).
              runAfterCommit('LLM residual pass', () => runLlmResidualPass(companyId, residualIds, userId, deps));
            }

            return apiResponse.success(res, { ...result, residualCount: willRunLlm ? residualIds.length : 0 });
          }
          // Otherwise, categorize specific transaction IDs
          if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
            return apiResponse.badRequest(res, 'transactionIds array or bankAccountId required');
          }
          const result = await bulkCategorize(companyId, transactionIds);
          const categorizedIds = result.results.filter((r) => r.result).map((r) => r.transactionId);
          const autoPost = await sweep(companyId, categorizedIds, 'categorization', userId);

          // Derive residual pass over the request's transaction ids
          const candidateRows = (await sql`
            SELECT id, status,
                   suggested_gl_account_id AS "suggestedGlAccountId",
                   suggested_confidence    AS "suggestedConfidence"
            FROM bank_transactions
            WHERE id = ANY(${transactionIds as string[]}::uuid[])
              AND company_id = ${companyId}::UUID
          `) as Array<{ id: string; status: string; suggestedGlAccountId: string | null; suggestedConfidence: number | null }>;
          const residualIds = selectResidualTxIds(
            candidateRows.map((r) => ({
              ...r,
              suggestedConfidence: r.suggestedConfidence == null ? null : Number(r.suggestedConfidence),
            })),
            MAX_LLM_CALLS_PER_RUN,
          );
          const apSettings = await getAutoPostSettings(companyId);
          const willRunLlm = apSettings.llmEnabled && residualIds.length > 0;
          if (willRunLlm) {
            const deps = await buildRunDeps(companyId, userId, residualIds);
            runAfterCommit('LLM residual pass', () => runLlmResidualPass(companyId, residualIds, userId, deps));
          }

          return apiResponse.success(res, { ...result, autoPost, residualCount: willRunLlm ? residualIds.length : 0 });
        }

        case 'learn': {
          if (!txId || !glAccountId || !category) {
            return apiResponse.badRequest(res, 'txId, glAccountId, and category required');
          }
          await learnFromAllocation(companyId, txId, glAccountId, category, vatCode);
          return apiResponse.success(res, { learned: true });
        }

        default:
          return apiResponse.badRequest(res, `Unknown action: ${action}`);
      }
    } catch (err) {
      log.error('Smart categorize POST failed', { action, error: err }, 'accounting-api');
      return apiResponse.badRequestFromError(res, err, 'Action failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
