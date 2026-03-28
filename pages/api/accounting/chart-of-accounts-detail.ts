/**
 * Chart of Accounts Detail API
 * GET    /api/accounting/chart-of-accounts-detail?id=... - Get single account
 * PUT    /api/accounting/chart-of-accounts-detail - Update account
 * DELETE /api/accounting/chart-of-accounts-detail - Delete (deactivate) account
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getAccountById,
  updateAccount,
  deleteAccount,
} from '@/modules/accounting/services/chartOfAccountsService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  const id = (req.query.id || req.body?.id) as string;

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
    try {
      const { accountName, description, isActive, displayOrder } = req.body;
      const account = await updateAccount(companyId, id, { accountName, description, isActive, displayOrder });
      return apiResponse.success(res, account);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update account';
      log.error('Failed to update account', { id, error: err }, 'accounting-api');
      return apiResponse.badRequest(res, message);
    }
  }

  if (req.method === 'DELETE') {
    if (!id) return apiResponse.badRequest(res, 'id is required');
    try {
      await deleteAccount(companyId, id);
      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete account';
      log.error('Failed to delete account', { id, error: err }, 'accounting-api');
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT', 'DELETE']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
