/**
 * GET   /api/accounting/bank-auto-post → { settings, runs (last ~20) }
 * PUT   body { enabled?, minConfidence?, amountCap?, llmEnabled?, llmMinConfidence?, llmAmountCap? } → upsert settings
 * POST  body { action: 'undo', runId } → undo a whole run
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
      return apiResponse.badRequestFromError(res, err, 'Undo failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'PUT', 'POST']);
}

export default withAuth(
  withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))),
);
