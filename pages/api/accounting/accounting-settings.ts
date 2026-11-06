/**
 * Accounting Settings API
 * GET  ?key=reporting_currency — get setting value
 * PUT  { key, value } — update one of WRITABLE_SETTING_KEYS (anything else is a 400). Every other key has its own route
 *      with its own gate: default_payment_terms is owner/admin only on company-settings?type=payment-terms, auto-post on
 *      bank-auto-post. A generic write would bypass those gates.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { getSetting, setSetting } from '@/modules/accounting/services/core/currencyService';

/**
 * The only keys this generic writer accepts: every key the app's own pages write through it (grep of the callers,
 * 2026-11-05: accounting-settings.tsx, DimensionsTab.tsx, company-settings.tsx). A deny-list would have to name every
 * row a service owns and validates (`accounting_default_accounts` holds the Default Accounts mappings and where payroll
 * net pay is credited; written here as free text it skipped the save's rules, and a non-JSON value stopped every
 * payroll calculation of the company), and a new owned row would be open until someone remembered to add it.
 * A page that needs a new key adds it here.
 */
const WRITABLE_SETTING_KEYS: readonly string[] = [
  'reporting_currency', 'enable_cost_centres', 'enable_business_units', 'document_display_fields',
];

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
    if (typeof key !== 'string' || !WRITABLE_SETTING_KEYS.includes(key)) {
      return apiResponse.badRequest(res, 'This setting cannot be written here (settings with their own page, such as Default Accounts, are saved there)');
    }
    if (typeof value !== 'string') return apiResponse.badRequest(res, 'value must be text');
    await setSetting(key, value, userId, companyId);
    return apiResponse.success(res, { updated: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
