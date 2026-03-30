/**
 * Migration Chart of Accounts API
 * POST /api/accounting/migration/chart-of-accounts
 * Body: { sessionId, accounts[], systemAccountMap }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { importChartOfAccounts, type AccountImportRow, type SystemAccountMap } from '@/modules/accounting/services/migrationCoaService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const { sessionId, accounts, systemAccountMap } = req.body as {
    sessionId?: string;
    accounts?: AccountImportRow[];
    systemAccountMap?: SystemAccountMap;
  };

  if (!sessionId?.trim()) {
    return apiResponse.validationError(res, { sessionId: 'Session ID is required' });
  }
  if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
    return apiResponse.validationError(res, { accounts: 'Non-empty accounts array is required' });
  }
  if (!systemAccountMap || typeof systemAccountMap !== 'object') {
    return apiResponse.validationError(res, { systemAccountMap: 'System account map is required' });
  }

  const result = await importChartOfAccounts(companyId, sessionId, accounts, systemAccountMap);

  log.info('Chart of accounts imported', {
    companyId,
    sessionId,
    imported: result.imported,
    skipped: result.skipped,
  }, 'migration');

  return apiResponse.success(res, result);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
