/**
 * Accounting Settings API
 * GET  ?key=reporting_currency — get setting value
 * PUT  { key, value } — update setting
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { getSetting, setSetting } from '@/modules/accounting/services/core/currencyService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { key } = req.query;
    if (!key) return apiResponse.badRequest(res, 'key is required');
    const value = await getSetting(key as string, companyId);
    return apiResponse.success(res, { key, value });
  }

  if (req.method === 'PUT') {
    const userId = req.user.id;
    const { key, value } = req.body;
    if (!key || !value) return apiResponse.badRequest(res, 'key and value required');
    await setSetting(key, value, userId, companyId);
    return apiResponse.success(res, { updated: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
