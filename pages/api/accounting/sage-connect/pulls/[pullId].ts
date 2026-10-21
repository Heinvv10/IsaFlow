/**
 * GET /api/accounting/sage-connect/pulls/{pullId}
 *
 * The state of one Sage read of THIS company — 'pulling' (with the step under
 * way), 'failed' (with a safe reason; a read gone quiet for 15 minutes reads as
 * failed), 'ready' (with the review, rebuilt from the stored pull against the
 * chart as it is now), or done with ('imported' / 'discarded' / 'expired').
 * The page polls it while the read runs. Expires the company's stale reviews
 * first, so a review past 24 hours is never shown.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { buildSageTakeOn } from '@/modules/accounting/services/sage/sageTakeOnBuilder';
import { readTakeOnContext } from '@/modules/accounting/services/sage/sageTakeOnContext';
import { loadPullState, purgeExpiredPulls } from '@/modules/accounting/services/sage/sageTakeOnStore';
import { pullPayload, toReview } from '@/modules/accounting/services/sage/sageConnectRequest';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const pullId = String(req.query.pullId ?? '');
  if (!UUID_RE.test(pullId)) return apiResponse.validationError(res, { pullId: 'pullId must be a review id' });
  const { companyId } = req as CompanyAuthedRequest;
  await purgeExpiredPulls(companyId);
  const state = await loadPullState(companyId, pullId);
  if (!state) return apiResponse.notFound(res, 'Sage review', pullId);
  const review = state.status === 'ready' && state.pull
    ? toReview(buildSageTakeOn(state.pull, await readTakeOnContext(companyId)))
    : null;
  return apiResponse.success(res, pullPayload(state, review));
}

export default withAuth(withErrorHandler(handler));
