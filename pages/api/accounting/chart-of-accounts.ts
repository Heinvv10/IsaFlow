/**
 * Chart of Accounts API
 * GET  /api/accounting/chart-of-accounts - List all accounts (flat or tree)
 * POST /api/accounting/chart-of-accounts - Create new account
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  getChartOfAccounts,
  getAccountTree,
  createAccount,
  updateAccount,
} from '@/modules/accounting/services/gl/chartOfAccountsService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    try {
      const { view, subtype, includeInactive } = req.query;
      const withInactive = includeInactive === 'true';
      let data;
      if (view === 'tree') {
        data = await getAccountTree(companyId, withInactive);
      } else {
        const accounts = await getChartOfAccounts(companyId, withInactive);
        data = subtype
          ? accounts.filter(a => a.accountSubtype === String(subtype))
          : accounts;
      }
      return apiResponse.success(res, data);
    } catch (err) {
      log.error('Failed to get chart of accounts', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Failed to get chart of accounts');
    }
  }

  if (req.method === 'POST') {
    try {
      const { accountCode, accountName, accountType, accountSubtype, parentAccountId, description, normalBalance, defaultVatCode, vatInputDenied } = req.body;

      if (!accountCode || !accountName || !accountType || !normalBalance) {
        return apiResponse.badRequest(res, 'accountCode, accountName, accountType, and normalBalance are required');
      }

      const account = await createAccount(companyId, {
        accountCode,
        accountName,
        accountType,
        accountSubtype,
        parentAccountId,
        description,
        normalBalance,
        defaultVatCode,
        vatInputDenied: typeof vatInputDenied === 'boolean' ? vatInputDenied : undefined,
      });

      return apiResponse.success(res, account);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create account';
      log.error('Failed to create account', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, message);
    }
  }

  if (req.method === 'PUT') {
    try {
      const { id, accountName, description, isActive, displayOrder, defaultVatCode, vatInputDenied } = req.body;
      if (!id) return apiResponse.badRequest(res, 'id is required');
      const updated = await updateAccount(companyId, id, {
        accountName, description, isActive, displayOrder, defaultVatCode,
        vatInputDenied: typeof vatInputDenied === 'boolean' ? vatInputDenied : undefined,
      });
      return apiResponse.success(res, updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update account';
      log.error('Failed to update account', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT']);
}

 
// Chart of accounts is a financial control point (affects trial balance
// and audit trails) — only owners and admins can create or edit GL
// accounts. Managers still have full read access and can do operational
// work (post journal entries, reconcile, etc.) through other endpoints.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler, { allowedRoles: ['owner', 'admin'] }))));
