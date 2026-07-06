/**
 * Close Agent v1 — apply a human decision to one proposal.
 *
 * POST /api/accounting/close-run/decide
 *   body { runId, proposalId, decision: 'approve' | 'reject' | 'dismiss' }
 *
 * 'approve' is the ONLY path that posts anything (auto_post proposals only);
 * every executed approval writes an audit row carrying the proposal reasoning.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  decideProposal,
  CloseRunNotFoundError,
  ProposalDecisionError,
} from '@/modules/accounting/services/gl/closeRun/closeRunService';
import type { Decision } from '@/modules/accounting/services/gl/closeRun/closeRunTypes';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECISIONS: Decision[] = ['approve', 'reject', 'dismiss'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);

  const authed = req as CompanyAuthedRequest;
  const companyId = authed.companyId;
  const userId = authed.user.id;
  const { runId, proposalId, decision } = (req.body ?? {}) as {
    runId?: string; proposalId?: string; decision?: string;
  };

  if (typeof runId !== 'string' || !UUID_RE.test(runId)) return apiResponse.badRequest(res, 'runId (UUID) is required');
  if (typeof proposalId !== 'string' || !UUID_RE.test(proposalId)) return apiResponse.badRequest(res, 'proposalId (UUID) is required');
  if (typeof decision !== 'string' || !DECISIONS.includes(decision as Decision)) {
    return apiResponse.badRequest(res, `decision must be one of ${DECISIONS.join(', ')}`);
  }

  try {
    const proposal = await decideProposal(companyId, runId, proposalId, decision as Decision, userId);
    return apiResponse.success(res, { proposal });
  } catch (err) {
    if (err instanceof CloseRunNotFoundError) return apiResponse.notFound(res, err.message);
    if (err instanceof ProposalDecisionError) return apiResponse.conflict(res, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
