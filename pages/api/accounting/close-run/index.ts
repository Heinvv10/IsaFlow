/**
 * Close Agent v1 — start / fetch a close run.
 *
 * POST /api/accounting/close-run   body { periodId }        → start a run (run + proposals)
 * GET  /api/accounting/close-run?runId=…                     → fetch a run by id
 * GET  /api/accounting/close-run?periodId=…                  → latest run for a period
 *
 * Starting a run only COMPUTES and persists proposals — nothing posts here.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  startCloseRun,
  getCloseRun,
  CloseRunNotFoundError,
} from '@/modules/accounting/services/gl/closeRun/closeRunService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const authed = req as CompanyAuthedRequest;
  const companyId = authed.companyId;
  const userId = authed.user.id;

  if (req.method === 'POST') {
    const { periodId } = (req.body ?? {}) as { periodId?: string };
    if (typeof periodId !== 'string' || !UUID_RE.test(periodId)) {
      return apiResponse.badRequest(res, 'periodId (UUID) is required');
    }
    try {
      const result = await startCloseRun(companyId, periodId, userId);
      return apiResponse.success(res, result);
    } catch (err) {
      if (err instanceof CloseRunNotFoundError) return apiResponse.notFound(res, err.message);
      throw err;
    }
  }

  if (req.method === 'GET') {
    const runId = typeof req.query.runId === 'string' ? req.query.runId : undefined;
    const periodId = typeof req.query.periodId === 'string' ? req.query.periodId : undefined;
    if (!runId && !periodId) return apiResponse.badRequest(res, 'runId or periodId is required');
    if (runId && !UUID_RE.test(runId)) return apiResponse.badRequest(res, 'runId must be a valid UUID');
    if (periodId && !UUID_RE.test(periodId)) return apiResponse.badRequest(res, 'periodId must be a valid UUID');

    const result = await getCloseRun(companyId, { runId, periodId });
    if (!result) return apiResponse.notFound(res, 'No close run found');
    return apiResponse.success(res, result);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

// withCsrf + withWriteAccess pass GET/HEAD/OPTIONS through unchanged and only
// gate the mutating POST (CSRF token + owner/admin/manager role).
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
