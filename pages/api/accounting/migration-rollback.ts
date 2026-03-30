/**
 * Migration Rollback API
 * POST /api/accounting/migration-rollback
 * Body: { source: MigrationSource }
 * Deletes GL accounts imported from the given source.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { rollbackMigration } from '@/modules/accounting/services/migrationExecuteService';
import type { MigrationSource } from '@/modules/accounting/services/migrationParserService';

const VALID_SOURCES: MigrationSource[] = ['xero', 'quickbooks', 'pastel'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const { source } = req.body as { source: string };

  if (!VALID_SOURCES.includes(source as MigrationSource)) {
    return apiResponse.badRequest(res, `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}`);
  }

  log.info('Migration rollback requested', { companyId, source }, 'migration');
  const result = await rollbackMigration(companyId, source as MigrationSource);
  return apiResponse.success(res, result);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
