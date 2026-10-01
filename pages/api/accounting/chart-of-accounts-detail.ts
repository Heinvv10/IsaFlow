/**
 * Chart of Accounts Detail API
 * GET    /api/accounting/chart-of-accounts-detail?id=... - Get single account
 * PUT    /api/accounting/chart-of-accounts-detail - Update account
 * PATCH  /api/accounting/chart-of-accounts-detail - Rename account code (allowed only while no postings)
 * DELETE /api/accounting/chart-of-accounts-detail - Delete (deactivate) account
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { accountUpdateBodyError, isServiceRefusal } from '@/lib/accountUpdateBody';
import { apiResponse } from '@/lib/apiResponse';
import { ErrorCode } from '@/lib/apiResponse.types';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  getAccountById,
  updateAccount,
  deleteAccount,
  renameAccountCode,
} from '@/modules/accounting/services/gl/chartOfAccountsService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const id = (req.query.id || req.body?.id) as unknown;
  if (id !== undefined && typeof id !== 'string') return apiResponse.badRequest(res, 'id must be a single account id');

  if (req.method === 'GET') {
    if (!id) return apiResponse.badRequest(res, 'id is required');
    try {
      const account = await getAccountById(companyId, id);
      if (!account) return apiResponse.notFound(res, 'Account', id);
      return apiResponse.success(res, account);
    } catch (err) {
      log.error('Failed to get account', { id, error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Failed to get account');
    }
  }

  if (req.method === 'PUT') {
    if (!id) return apiResponse.badRequest(res, 'id is required');
    const bodyError = accountUpdateBodyError(req.body);
    if (bodyError) return apiResponse.badRequest(res, bodyError);
    try {
      const { accountName, description, isActive, displayOrder } = req.body;
      const account = await updateAccount(companyId, id, { accountName, description, isActive, displayOrder });
      return apiResponse.success(res, account);
    } catch (err) {
      log.error('Failed to update account', { id, error: err }, 'accounting-api');
      // Only a refusal is a 400: a 4xx COMMITS, so anything else goes to withErrorHandler
      // (500, rolled back; a role-lock timeout is 503 + Retry-After there).
      if (!isServiceRefusal(err)) throw err;
      return apiResponse.badRequest(res, err.message);
    }
  }

  if (req.method === 'PATCH') {
    if (!id) return apiResponse.badRequest(res, 'id is required');
    try {
      const { accountCode } = req.body || {};
      if (!accountCode || typeof accountCode !== 'string') {
        return apiResponse.badRequest(res, 'accountCode is required');
      }
      const account = await renameAccountCode(companyId, id, accountCode);
      return apiResponse.success(res, account);
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      const message = err instanceof Error ? err.message : 'Failed to rename account code';
      log.error('Failed to rename account code', { id, error: err }, 'accounting-api');
      if (code === 'HAS_TRANSACTIONS') {
        return apiResponse.error(res, ErrorCode.CONFLICT, message, { reason: 'HAS_TRANSACTIONS' });
      }
      if (!isServiceRefusal(err)) throw err;
      return apiResponse.badRequest(res, message);
    }
  }

  if (req.method === 'DELETE') {
    if (!id) return apiResponse.badRequest(res, 'id is required');
    try {
      await deleteAccount(companyId, id);
      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      log.error('Failed to delete account', { id, error: err }, 'accounting-api');
      if (!isServiceRefusal(err)) throw err;
      return apiResponse.badRequest(res, err.message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT', 'PATCH', 'DELETE']);
}

 
// Chart of accounts is a financial control point — only owners and
// admins can update or delete GL accounts (including bank accounts).
// The deleteAccount() service layer also refuses to delete a bank
// account with a non-zero GL balance or unreconciled transactions.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler, { allowedRoles: ['owner', 'admin'] }))));
