/**
 * Default Accounts Configuration API
 * GET /api/accounting/default-accounts - Get default account mappings
 * POST /api/accounting/default-accounts - Save default account mappings
 *   body: { mappings: {uiKey: accountId} (only the keys changed),
 *           loaded: {uiKey: accountId} (the holder the page showed for each) }
 *   `loaded` is required for every key that moves a role: an omitted `loaded`
 *   (or key) means "the page showed Not configured", so a role that has a
 *   holder answers 409. A `loaded` that is not an object is 400.
 * Sage equivalent: Accounts > Default Accounts
 *
 * The rules live in defaultAccountsService: GET shows the live role holders;
 * a save moves only the roles it changes and refuses (rolled back) anything
 * that would leave a role on an account the user did not choose.
 *
 * `payroll_net_pay` (where a pay run credits net pay) and `primary_bank` (the bank
 * role, which net pay credits when `payroll_net_pay` is unset) may be set by an owner
 * or admin only: managers can approve payroll, and one who could also redirect net
 * pay could do both in a session. A manager naming either gets a 403 and nothing
 * is saved; the other keys behave as for any writer.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { canSetPayrollNetPay } from '@/lib/auth/writeRoles';
import { isNetPayControlKey } from '@/modules/accounting/services/gl/defaultAccountRoles';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { withTransaction } from '@/lib/neon';
import { runAfterCommit } from '@/lib/afterCommit';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import {
  DefaultAccountsRefusal, plainMapping, readDefaultAccountMappings, saveDefaultAccountMappings,
} from '@/modules/accounting/services/gl/defaultAccountsService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    try {
      return apiResponse.success(res, { mappings: await readDefaultAccountMappings(companyId) });
    } catch (err) {
      log.error('Failed to fetch default accounts', { error: err instanceof Error ? err.message : String(err), module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to fetch default accounts');
    }
  }

  if (req.method === 'POST') {
    const { mappings, loaded } = req.body;

    if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
      return apiResponse.validationError(res, { mappings: 'Object of key-value mappings required' });
    }

    if (loaded != null && (typeof loaded !== 'object' || Array.isArray(loaded))) {
      return apiResponse.badRequest(res, '`loaded` must be an object of the holders the page showed');
    }

    const controlKey = Object.keys(mappings).find(isNetPayControlKey);
    if (controlKey !== undefined && !canSetPayrollNetPay(companyRole)) {
      return apiResponse.forbidden(res, `Your role (${companyRole ?? 'unknown'}) cannot change '${controlKey}', which decides where payroll net pay is credited: only an owner or admin can.`);
    }

    try {
      await withTransaction((tx) => saveDefaultAccountMappings(
        tx, companyId, mappings as Record<string, unknown>, plainMapping(loaded), user.id));
    } catch (err) {
      if (err instanceof DefaultAccountsRefusal) {
        return err.status === 409 ? apiResponse.conflict(res, err.message) : apiResponse.badRequest(res, err.message);
      }
      if (respondIfLockTimeout(res, err)) return;
      log.error('Failed to save default accounts', { error: err instanceof Error ? err.message : String(err), module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to save default accounts');
    }
    // After COMMIT: cleared earlier, a concurrent read in the gap re-caches the
    // old holder for up to the cache TTL and posts to it.
    runAfterCommit('default-accounts: clear system account cache', async () => clearSystemAccountCache(companyId));
    log.info('Default accounts saved and system flags synced', { keys: Object.keys(mappings), module: 'accounting' });
    return apiResponse.success(res, { saved: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
