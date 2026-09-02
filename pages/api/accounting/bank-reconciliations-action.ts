/**
 * Bank Reconciliation Actions API
 * POST /api/accounting/bank-reconciliations-action
 *   action: complete | cancel | adjustment
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import {
  completeReconciliation,
  createAdjustmentEntry,
} from '@/modules/accounting/services/bank/bankReconciliationService';
import { cancelReconciliation } from '@/modules/accounting/services/bank/bankReconciliationCancelService';

const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('complete'), reconciliationId: UUID }),
  z.object({ action: z.literal('cancel'), reconciliationId: UUID }),
  z.object({
    action: z.literal('adjustment'),
    reconciliationId: UUID,
    bankAccountId: UUID,
    contraAccountId: UUID,
    amount: z.union([z.number(), z.string()]).transform(v => Number(v)).refine(n => Number.isFinite(n), { message: 'amount must be numeric' }),
    description: z.string().min(1).max(500),
  }),
]);

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const parsed = ActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    }
    const body = parsed.data;
    const userId = req.user.id;

    if (body.action === 'complete') {
      const recon = await completeReconciliation(companyId, body.reconciliationId, userId);
      return apiResponse.success(res, recon);
    }
    if (body.action === 'cancel') {
      const result = await cancelReconciliation(companyId, body.reconciliationId, userId);
      return apiResponse.success(res, result);
    }
    // adjustment
    const jeId = await createAdjustmentEntry(
      companyId, body.reconciliationId, body.bankAccountId, body.contraAccountId,
      body.amount, body.description, userId,
    );
    return apiResponse.success(res, { journalEntryId: jeId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Action failed';
    log.error('Bank reconciliation action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
