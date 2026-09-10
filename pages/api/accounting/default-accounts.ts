/**
 * Default Accounts Configuration API
 * GET /api/accounting/default-accounts - Get default account mappings
 * POST /api/accounting/default-accounts - Save default account mappings
 * Sage equivalent: Accounts > Default Accounts
 *
 * Stores mappings in app_settings AND syncs is_system_account + account_subtype
 * on the selected GL accounts so systemAccountResolver picks them up.
 * All GL mutations run inside a single transaction so a partial failure
 * cannot leave system flags in a corrupt state.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { requireControlTx } from '@/modules/accounting/services/controls/context';
import { saveDefaultAccounts } from '@/modules/accounting/services/gl/defaultAccountsControl';
import { DefaultAccountsValidationError } from '@/modules/accounting/services/gl/defaultAccountsInput';

const SETTINGS_KEY = 'accounting_default_accounts';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    try {
      let mappings: Record<string, string> = {};
      const [row] = await sql`
        SELECT value FROM app_settings WHERE key = ${SETTINGS_KEY} AND company_id = ${companyId}
      `;
      if (row?.value) {
        mappings = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      }
      return apiResponse.success(res, { mappings });
    } catch (err) {
      log.error('Failed to fetch default accounts', { error: err instanceof Error ? err.message : String(err), module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to fetch default accounts');
    }
  }

  if (req.method === 'POST') {
    try {
      return apiResponse.success(res, await saveDefaultAccounts(requireControlTx(), req.body));
    } catch (error) {
      if (error instanceof DefaultAccountsValidationError) return apiResponse.badRequest(res, error.message);
      throw error;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
