/**
 * Migration Chart of Accounts API
 * POST /api/accounting/migration/chart-of-accounts
 * Body: { sessionId, accounts[], systemAccountMap }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { importSizeError } from '@/modules/accounting/services/core/migrationRowCaps';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { importChartOfAccounts, type AccountImportRow, type SystemAccountMap } from '@/modules/accounting/services/core/migrationCoaService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
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
  const sizeError = importSizeError(accounts.length);
  if (sizeError) return apiResponse.badRequest(res, sizeError);
  // Every field is text (or absent): `accountType: ['asset']` or a numeric
  // code reached the service and SQL, and answered 500 or compared unequal.
  const badRow = accounts.findIndex((row: unknown) => !row || typeof row !== 'object' || Array.isArray(row)
    || ['accountCode', 'accountName', 'accountType', 'normalBalance'].some((k) => typeof (row as Record<string, unknown>)[k] !== 'string')
    || ['accountSubtype', 'parentCode', 'description'].some((k) => {
      const v = (row as Record<string, unknown>)[k];
      return v !== undefined && v !== null && typeof v !== 'string';
    }));
  if (badRow >= 0) {
    return apiResponse.badRequest(res, `Account row ${badRow + 1}: accountCode, accountName, accountType and normalBalance must be text, and accountSubtype, parentCode and description text or empty.`);
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

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
