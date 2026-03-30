/**
 * Chart of Accounts API
 * GET  /api/accounting/chart-of-accounts - List all accounts (flat or tree)
 * POST /api/accounting/chart-of-accounts - Create new account
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getChartOfAccounts,
  getAccountTree,
  createAccount,
  updateAccount,
} from '@/modules/accounting/services/chartOfAccountsService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

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
      const { accountCode, accountName, accountType, accountSubtype, parentAccountId, description, normalBalance } = req.body;

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
      const { id, accountName, description, isActive, displayOrder, defaultVatCode } = req.body;
      if (!id) return apiResponse.badRequest(res, 'id is required');
      const updated = await updateAccount(companyId, id, { accountName, description, isActive, displayOrder, defaultVatCode });
      return apiResponse.success(res, updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update account';
      log.error('Failed to update account', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
