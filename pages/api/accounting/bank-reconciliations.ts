/**
 * Bank Reconciliations API
 * GET  /api/accounting/bank-reconciliations - List reconciliation sessions
 * POST /api/accounting/bank-reconciliations - Start new reconciliation
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getReconciliations,
  getReconciliationById,
  startReconciliation,
} from '@/modules/accounting/services/bankReconciliationService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    try {
      const { bank_account_id, id } = req.query;

      if (id) {
        const recon = await getReconciliationById(companyId, String(id));
        if (!recon) return apiResponse.notFound(res, 'Reconciliation', String(id));
        return apiResponse.success(res, recon);
      }

      const result = await getReconciliations(
        companyId, bank_account_id ? String(bank_account_id) : undefined
      );
      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to get reconciliations', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Failed to get reconciliations');
    }
  }

  if (req.method === 'POST') {
    try {
      const { bankAccountId, statementDate, statementBalance } = req.body;
      // User identity comes from JWT (req.user), never from client request body
      const userId = req.user.id;

      if (!bankAccountId || !statementDate || statementBalance === undefined) {
        return apiResponse.badRequest(res, 'bankAccountId, statementDate, and statementBalance are required');
      }

      const recon = await startReconciliation(
        companyId, String(bankAccountId), String(statementDate),
        Number(statementBalance), userId
      );
      return apiResponse.created(res, recon);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start reconciliation';
      log.error('Failed to start reconciliation', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
