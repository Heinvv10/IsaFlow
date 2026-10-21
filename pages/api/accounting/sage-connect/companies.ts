/**
 * POST /api/accounting/sage-connect/companies
 * Body: { email, password } — the client's Sage Accounting login.
 *
 * Signs in to Sage and lists the companies that login can open, so the client
 * can pick which one to bring across. The login is used for this one call and
 * not kept: the next step sends it again.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { answerSageError, clientFromLogin, sageConnectAvailable, toCompanyOptions } from '@/modules/accounting/services/sage/sageConnectRequest';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  if (!sageConnectAvailable()) {
    return apiResponse.badRequest(res, 'The Sage connection is not switched on yet. Use "Upload Sage reports" instead.', { sageError: 'not_configured' });
  }
  const login = clientFromLogin(req.body);
  if (!login.ok) return apiResponse.validationError(res, { [login.field]: login.message });

  const { companyId } = req as CompanyAuthedRequest;
  try {
    const companies = await login.client.listCompanies();
    log.info('Sage companies listed', { companyId, count: companies.length }, 'migration');
    return apiResponse.success(res, toCompanyOptions(companies));
  } catch (err) {
    log.warn('Sage company list failed', { companyId, error: err instanceof Error ? err.message : String(err) }, 'migration');
    if (answerSageError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
