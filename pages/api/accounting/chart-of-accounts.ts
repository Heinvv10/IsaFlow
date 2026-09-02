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
import {
  reclassifyAccount,
  ReclassifyError,
} from '@/modules/accounting/services/gl/accountReclassifyService';

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
    const {
      id, accountName, description, isActive, displayOrder, defaultVatCode, vatInputDenied,
      accountSubtype, parentAccountId,
    } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');

    // Reclassification runs FIRST and on its own guards. `undefined` means
    // "leave alone" and `null` means "clear", so both have to be
    // distinguishable here — a `?? undefined` would silently turn every clear
    // into a no-op, which is how these two columns became unwritable in the
    // first place.
    const changingSubtype = accountSubtype !== undefined;
    const changingParent = parentAccountId !== undefined;
    let reclassified = false;

    if (changingSubtype || changingParent) {
      try {
        await reclassifyAccount(companyId, id, {
          ...(changingSubtype ? { accountSubtype: accountSubtype || null } : {}),
          ...(changingParent ? { parentAccountId: parentAccountId || null } : {}),
        });
        reclassified = true;
      } catch (err) {
        // Only a REFUSAL is a 400. Anything else must reach withErrorHandler as
        // a 500 — `withAuth` decides COMMIT vs ROLLBACK on `statusCode >= 500`,
        // so mapping an unexpected failure to 400 would COMMIT whatever the
        // service had already written.
        if (err instanceof ReclassifyError) return apiResponse.badRequest(res, err.message);
        throw err;
      }
    }

    // Past this point a 4xx would COMMIT the reclassify above while telling the
    // client the request failed — a silent partial write. So once reclassify
    // has written, an updateAccount failure RETHROWS (500 → ROLLBACK) instead
    // of being flattened into a 400. Before it has written there is nothing to
    // unwind, and the service's own validation message is more useful than a
    // 500.
    try {
      const updated = await updateAccount(companyId, id, {
        accountName, description, isActive, displayOrder, defaultVatCode,
        vatInputDenied: typeof vatInputDenied === 'boolean' ? vatInputDenied : undefined,
      });
      return apiResponse.success(res, updated);
    } catch (err) {
      log.error('Failed to update account', { error: err }, 'accounting-api');
      if (reclassified) throw err;
      return apiResponse.badRequest(
        res, err instanceof Error ? err.message : 'Failed to update account',
      );
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT']);
}

 
// Chart of accounts is a financial control point (affects trial balance
// and audit trails) — only owners and admins can create or edit GL
// accounts. Managers still have full read access and can do operational
// work (post journal entries, reconcile, etc.) through other endpoints.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler, { allowedRoles: ['owner', 'admin'] }))));
