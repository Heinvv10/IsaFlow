/**
 * POST /api/accounting/sage-connect/preview
 * Body: { email, password, sageCompanyId }
 *
 * Reads the chosen Sage company (read-only, as at today), builds the take-on
 * against this company's chart, stores what was read (not the login) and
 * returns the review: accounts, opening balances, customers, suppliers,
 * outstanding documents, control-account reconciliation and any issues.
 * Nothing is written to the ledger here.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { pullSageCompany } from '@/modules/accounting/services/sage/sageApiPullService';
import { buildSageTakeOn } from '@/modules/accounting/services/sage/sageTakeOnBuilder';
import { readTakeOnContext, savePull, summarise } from '@/modules/accounting/services/sage/sageTakeOnStore';
import {
  answerSageError, clientFromLogin, previewPayload, sageConnectAvailable, todayInSouthAfrica,
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
  const started = Date.now();
  try {
    const pull = await pullSageCompany(login.client, sageCompanyId, todayInSouthAfrica());
    const takeOn = buildSageTakeOn(pull, await readTakeOnContext(companyId));
    const summary = summarise(takeOn);
    const pullId = await savePull(companyId, userId, pull, summary);
    log.info('Sage pull reviewed', { companyId, pullId, sageCompanyId, ms: Date.now() - started, ...summary.counts, errors: summary.errors }, 'migration');
    return apiResponse.success(res, previewPayload(pullId, takeOn, summary));
  } catch (err) {
    log.warn('Sage pull failed', { companyId, sageCompanyId, error: err instanceof Error ? err.message : String(err) }, 'migration');
    if (answerSageError(res, err)) return;
    if (err instanceof Error && /file upload/i.test(err.message)) return apiResponse.badRequest(res, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
