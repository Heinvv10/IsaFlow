/**
 * Bank Reconciliations API
 * GET  /api/accounting/bank-reconciliations - List reconciliation sessions
 * POST /api/accounting/bank-reconciliations - Start new reconciliation
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import {
  getReconciliations,
  getReconciliationById,
  startReconciliation,
} from '@/modules/accounting/services/bank/bankReconciliationService';
import { assertBankAccountInCompany, isBankAccountGuardRefusal } from '@/modules/accounting/services/bank/bankAccountGuard';

const StartReconSchema = z.object({
  bankAccountId: UUID,
  statementDate: z.string().min(8).max(30),
  statementBalance: z.union([z.number(), z.string()]).transform(v => Number(v)).refine(n => Number.isFinite(n), {
    message: 'statementBalance must be numeric',
  }),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    try {
      const { bank_account_id, id } = req.query;
      // Ids are checked before the query (a malformed one reached a ::UUID cast and answered 400 'Failed to get…' at best):
      // a repeated parameter (an array) fails too.
      for (const [name, v] of [['id', id], ['bank_account_id', bank_account_id]] as const) {
        if (v !== undefined && v !== '' && !UUID.safeParse(v).success) return apiResponse.badRequest(res, `${name} must be a valid UUID`);
      }

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
      const parsed = StartReconSchema.safeParse(req.body);
      if (!parsed.success) {
        return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
      }
      const { bankAccountId, statementDate, statementBalance } = parsed.data;
      // User identity comes from JWT (req.user), never from client request body
      const userId = req.user.id;
      // An active bank account of this company, before the session is written (audit 2026-11-15 WP2-1: any id was taken).
      await assertBankAccountInCompany(companyId, bankAccountId);

      const recon = await startReconciliation(
        companyId, bankAccountId, statementDate, statementBalance, userId,
      );
      return apiResponse.created(res, recon);
    } catch (err) {
      if (respondIfLockTimeout(res, err)) return;
      if (isBankAccountGuardRefusal(err)) return apiResponse.badRequest(res, err.message);
      // Audit WP2 row 9: anything else is a fault — rethrown (500, rolled back). A 400 here COMMITTED a session a
      // crash had already inserted.
      log.error('Failed to start reconciliation', { error: err }, 'accounting-api');
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
