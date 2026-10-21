/**
 * POST /api/accounting/sage-connect/discard
 * Body: { pullId }
 * Throws away a review the client decided not to import; the data read from
 * Sage is cleared from the database at once.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { discardPull } from '@/modules/accounting/services/sage/sageTakeOnStore';
import { discardPayload } from '@/modules/accounting/services/sage/sageConnectRequest';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  const pullId = String((req.body ?? {}).pullId ?? '');
  if (!UUID_RE.test(pullId)) return apiResponse.validationError(res, { pullId: 'pullId is required' });
  const { companyId } = req as CompanyAuthedRequest;
  const discarded = await discardPull(companyId, pullId);
  if (!discarded) return apiResponse.notFound(res, 'Sage review', pullId);
  log.info('Sage review discarded', { companyId, pullId }, 'migration');
  return apiResponse.success(res, discardPayload());
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
