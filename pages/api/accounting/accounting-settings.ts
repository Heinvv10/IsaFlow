/**
 * Accounting Settings API
 * GET  ?key=reporting_currency — get setting value
 * PUT  { key, value } — update setting; only the keys in WRITABLE_KEYS (the ones the settings pages save here).
 *      Every other key has its own route with its own gate: default_payment_terms is owner/admin only on
 *      company-settings?type=payment-terms, auto-post on bank-auto-post. A generic write would bypass those gates.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { getSetting, setSetting } from '@/modules/accounting/services/core/currencyService';

/** The keys the UI saves through this route: Accounting Settings (currency), Dimensions tab, Company settings (display fields). */
const WRITABLE_KEYS: ReadonlySet<string> = new Set([
  'reporting_currency', 'enable_cost_centres', 'enable_business_units', 'document_display_fields',
]);

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
    if (typeof key !== 'string' || typeof value !== 'string') return apiResponse.badRequest(res, 'key and value must be text');
    if (!WRITABLE_KEYS.has(key)) return apiResponse.badRequest(res, `The setting "${key}" cannot be changed here`);
    await setSetting(key, value, userId, companyId);
    return apiResponse.success(res, { updated: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
