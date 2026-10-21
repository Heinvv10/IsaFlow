/**
 * POST /api/accounting/sage-connect/preview
 * Body: { email, password, sageCompanyId }
 *
 * Starts reading the chosen Sage company (read-only, as at today) and answers
 * at once with { pullId, status: 'pulling' }: a read takes minutes, longer than
 * a request may run. The read runs after this request commits, in the
 * background (sagePullJob), holding the Sage login in memory only; the page
 * polls GET /api/accounting/sage-connect/pulls/{pullId} for the review.
 * Nothing is written to the ledger here.
 *
 * Refused up front (400): the connection is off, the company already has a
 * take-on, a read is already running for it, or every pull slot is busy.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { runAfterCommit } from '@/lib/afterCommit';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { BUSY_MESSAGE, pullSlotFree, runSagePull } from '@/modules/accounting/services/sage/sagePullJob';
import { findPriorTakeOn } from '@/modules/accounting/services/sage/sageTakeOnContext';
import { SagePullRefused, startPull } from '@/modules/accounting/services/sage/sageTakeOnStore';
import {
  clientFromLogin, sageConnectAvailable, startedPayload, todayInSouthAfrica,
} from '@/modules/accounting/services/sage/sageConnectRequest';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  if (!sageConnectAvailable()) {
    return apiResponse.badRequest(res, 'The Sage connection is not switched on yet. Use "Upload Sage reports" instead.', { sageError: 'not_configured' });
  }
  const sageCompanyId = Number((req.body ?? {}).sageCompanyId);
  if (!Number.isInteger(sageCompanyId) || sageCompanyId <= 0) {
    return apiResponse.validationError(res, { sageCompanyId: 'Choose the Sage company to bring across' });
  }
  const login = clientFromLogin(req.body);
  if (!login.ok) return apiResponse.validationError(res, { [login.field]: login.message });

  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const prior = await findPriorTakeOn(companyId);
  if (prior) return apiResponse.badRequest(res, prior, { sageError: 'already_imported' });
  if (!pullSlotFree()) return apiResponse.badRequest(res, BUSY_MESSAGE, { sageError: 'busy' });

  const asAtDate = todayInSouthAfrica();
  let pullId: string;
  try {
    pullId = await startPull(companyId, userId, sageCompanyId, asAtDate);
  } catch (err) {
    if (err instanceof SagePullRefused) return apiResponse.badRequest(res, err.message, { sageError: 'in_progress' });
    throw err;
  }
  const client = login.client;
  runAfterCommit('sage pull', () => runSagePull({ companyId, pullId, client, sageCompanyId, asAtDate }));
  log.info('Sage pull started', { companyId, pullId, sageCompanyId }, 'migration');
  return apiResponse.success(res, startedPayload(pullId));
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
