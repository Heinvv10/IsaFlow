/**
 * Migration Execute API
 * POST /api/accounting/migration-execute
 * Body: { source, accounts, customers, suppliers }
 * Returns: ExecuteMigrationResult
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { executeMigration } from '@/modules/accounting/services/migrationExecuteService';
import type { MigrationSource } from '@/modules/accounting/services/migrationParserService';

const VALID_SOURCES: MigrationSource[] = ['xero', 'quickbooks', 'pastel'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const { source, accounts = [], customers = [], suppliers = [] } = req.body as {
    source: string;
    accounts: unknown[];
    customers: unknown[];
    suppliers: unknown[];
  };

  if (!VALID_SOURCES.includes(source as MigrationSource)) {
    return apiResponse.badRequest(res, `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}`);
  }

  log.info('Migration execute requested', {
    companyId, source, accounts: accounts.length, customers: customers.length, suppliers: suppliers.length,
  }, 'migration');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await executeMigration(companyId, userId, source as MigrationSource, accounts as any, customers as any, suppliers as any);
  return apiResponse.success(res, result);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
