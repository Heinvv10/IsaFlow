/**
 * Bank Reconciliation Actions API
 * POST /api/accounting/bank-reconciliations-action
 *   action: complete | adjustment
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  completeReconciliation,
  createAdjustmentEntry,
} from '@/modules/accounting/services/bankReconciliationService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const { action, reconciliationId } = req.body;
    const userId = req.user.id;

    if (!action || !reconciliationId) {
      return apiResponse.badRequest(res, 'action and reconciliationId are required');
    }

    switch (action) {
      case 'complete': {
        const recon = await completeReconciliation(companyId, reconciliationId, userId);
        return apiResponse.success(res, recon);
      }
      case 'adjustment': {
        const { bankAccountId, contraAccountId, amount, description } = req.body;
        if (!bankAccountId || !contraAccountId || amount === undefined || !description) {
          return apiResponse.badRequest(res, 'bankAccountId, contraAccountId, amount, and description are required');
        }
        const jeId = await createAdjustmentEntry(
          companyId, reconciliationId, bankAccountId, contraAccountId,
          Number(amount), description, userId
        );
        return apiResponse.success(res, { journalEntryId: jeId });
      }
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Action failed';
    log.error('Bank reconciliation action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
