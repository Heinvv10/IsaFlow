/**
 * GET   /api/accounting/bank-auto-post → { settings, runs (last ~20) }
 * PUT   body { enabled?, minConfidence?, amountCap?, llmEnabled?, llmMinConfidence?, llmAmountCap? } → upsert settings
 * POST  body { action: 'undo', runId } → undo a whole run
 * POST  body { action: 'confirmHandCorrection' | 'undoAnyway', runId, transactionId, offsetJournalId }
 *       → the two recorded decisions on a line the undo refused (R-079): that
 *         journal is the correction (posts nothing), or it is not (undo the line)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  getAutoPostSettings,
  updateAutoPostSettings,
} from '@/modules/accounting/services/bank/autoPostGateService';
import { undoRun } from '@/modules/accounting/services/bank/autoPostUndoService';
import {
  HandCorrectionRefusedError,
  markCorrectedByHand,
  undoAnyway,
} from '@/modules/accounting/services/bank/autoPostHandCorrection';
import { isUuidParam } from '@/lib/validation';
import { isRetryableContention } from '@/modules/accounting/services/core/retryableContention';

type Row = Record<string, unknown>;

interface PutBody {
  enabled?: boolean;
  minConfidence?: number;
  amountCap?: number;
  llmEnabled?: boolean;
  llmMinConfidence?: number;
  llmAmountCap?: number;
}

interface PostBody {
  action?: string;
  runId?: string;
  transactionId?: string;
  offsetJournalId?: string;
}

/**
 * A person's recorded decision about the journal the undo named: it IS the
 * correction of that line, or it is not and the line is undone anyway.
 * Refusals are written for the user and raised before any write, and the
 * undo-anyway savepoint takes its declaration back with a failed reversal, so
 * a 4xx here commits nothing.
 */
async function handDecision(req: CompanyAuthedRequest, res: NextApiResponse, body: PostBody) {
  const { action, runId, transactionId, offsetJournalId } = body;
  if (!isUuidParam(runId) || !isUuidParam(transactionId) || !isUuidParam(offsetJournalId)) {
    return apiResponse.badRequest(res, `${action} requires runId, transactionId and offsetJournalId`);
  }
  try {
    const decide = action === 'undoAnyway' ? undoAnyway : markCorrectedByHand;
    const result = await decide(req.companyId, runId, transactionId, offsetJournalId, req.user.id);
    return apiResponse.success(res, result);
  } catch (err) {
    if (err instanceof HandCorrectionRefusedError) return apiResponse.badRequest(res, err.message);
    if (isRetryableContention(err)) return apiResponse.conflict(res, (err as Error).message);
    throw err;
  }
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId = req.user.id;

  if (req.method === 'GET') {
    const settings = await getAutoPostSettings(companyId);
    const runs = (await sql`
      SELECT id, source, posted_count, total_amount, created_at, undone_at
      FROM bank_auto_post_runs
      WHERE company_id = ${companyId}::UUID
      ORDER BY created_at DESC
      LIMIT 20
    `) as Row[];
    return apiResponse.success(res, {
      settings,
      runs: runs.map((r) => ({
        id: String(r.id),
        source: String(r.source),
        postedCount: Number(r.posted_count),
        totalAmount: Number(r.total_amount),
        createdAt: r.created_at,
        undoneAt: r.undone_at,
      })),
    });
  }

  if (req.method === 'PUT') {
    const body = (req.body ?? {}) as PutBody;
    if (
      body.enabled === undefined &&
      body.minConfidence === undefined &&
      body.amountCap === undefined &&
      body.llmEnabled === undefined &&
      body.llmMinConfidence === undefined &&
      body.llmAmountCap === undefined
    ) {
      return apiResponse.badRequest(
        res,
        'At least one of enabled | minConfidence | amountCap | llmEnabled | llmMinConfidence | llmAmountCap is required',
      );
    }
    try {
      const settings = await updateAutoPostSettings(companyId, body, userId);
      return apiResponse.success(res, { settings });
    } catch (err) {
      return apiResponse.badRequestFromError(res, err, 'Invalid auto-post settings');
    }
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as PostBody;
    if (body.action === 'confirmHandCorrection' || body.action === 'undoAnyway') return handDecision(req, res, body);
    if (body.action !== 'undo' || !body.runId) {
      return apiResponse.badRequest(res, "POST requires { action: 'undo', runId }");
    }
    try {
      const result = await undoRun(companyId, body.runId, userId);
      log.info(
        'Auto-post run undo requested',
        { companyId, runId: body.runId, ...result },
        'bank-auto-post',
      );
      return apiResponse.success(res, result);
    } catch (err) {
      // Peers held the run's lines and nothing else was written. `undoRun`
      // skips a contended row under its own savepoint and throws only when no
      // row was written at all, so the COMMIT withAuth issues for this 4xx
      // commits nothing and retrying is the whole remedy. A partly-undone run
      // is a 200 carrying `skipped` and `undone: false` instead.
      if (isRetryableContention(err)) {
        log.info('Auto-post undo hit a contended line', { companyId, runId: body.runId }, 'bank-auto-post');
        return apiResponse.conflict(res, (err as Error).message);
      }
      return apiResponse.badRequestFromError(res, err, 'Undo failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'PUT', 'POST']);
}

export default withAuth(
  withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))),
);
