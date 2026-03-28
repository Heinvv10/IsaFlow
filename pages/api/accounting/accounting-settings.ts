/**
 * Accounting Settings API
 * GET  ?key=reporting_currency — get setting value
 * PUT  { key, value } — update setting
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest } from '@/lib/auth';
import { getSetting, setSetting } from '@/modules/accounting/services/currencyService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const { key } = req.query;
    if (!key) return apiResponse.badRequest(res, 'key is required');
    const value = await getSetting(key as string);
    return apiResponse.success(res, { key, value });
  }

  if (req.method === 'PUT') {
    const userId = req.user.id;
    const { key, value } = req.body;
    if (!key || !value) return apiResponse.badRequest(res, 'key and value required');
    await setSetting(key, value, userId);
    return apiResponse.success(res, { updated: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
