/**
 * Migration Opening Balances API
 * POST /api/accounting/migration/opening-balances
 * Body: { sessionId, effectiveDate, balances[] }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  importOpeningBalances,
  type OpeningBalanceRow,
} from '@/modules/accounting/services/core/migrationImportService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const { sessionId, effectiveDate, balances } = req.body as {
    sessionId?: string;
    effectiveDate?: string;
    balances?: OpeningBalanceRow[];
  };

  if (!sessionId?.trim()) {
    return apiResponse.validationError(res, { sessionId: 'Session ID is required' });
  }
  if (!effectiveDate?.trim()) {
    return apiResponse.validationError(res, { effectiveDate: 'Effective date is required' });
  }
  if (!balances || !Array.isArray(balances) || balances.length === 0) {
    return apiResponse.validationError(res, { balances: 'Non-empty balances array is required' });
  }

  const result = await importOpeningBalances(companyId, sessionId, effectiveDate, balances, userId);

  log.info('Opening balances imported', {
    companyId,
    sessionId,
    journalEntryId: result.journalEntryId,
  }, 'migration');

  return apiResponse.success(res, result);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
