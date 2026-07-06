/**
 * Close Agent v1 — complete a close run.
 *
 * POST /api/accounting/close-run/complete   body { runId }
 *
 * Refuses while any proposal is still undecided — you cannot honestly "close"
 * a period with open checklist items. Writes an audit row for the close event.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  completeCloseRun,
  CloseRunNotFoundError,
  ProposalDecisionError,
} from '@/modules/accounting/services/gl/closeRun/closeRunService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);

  const authed = req as CompanyAuthedRequest;
  const companyId = authed.companyId;
  const userId = authed.user.id;
  const { runId } = (req.body ?? {}) as { runId?: string };
  if (typeof runId !== 'string' || !UUID_RE.test(runId)) return apiResponse.badRequest(res, 'runId (UUID) is required');

  try {
    const result = await completeCloseRun(companyId, runId, userId);
    return apiResponse.success(res, result);
  } catch (err) {
    if (err instanceof CloseRunNotFoundError) return apiResponse.notFound(res, err.message);
    if (err instanceof ProposalDecisionError) return apiResponse.conflict(res, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
