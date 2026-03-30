/**
 * Migration Customers API
 * POST /api/accounting/migration/customers
 * Body: { sessionId, customers[], duplicateStrategy }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  importCustomers,
  type CustomerImportRow,
  type DuplicateStrategy,
} from '@/modules/accounting/services/migrationContactService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const { sessionId, customers, duplicateStrategy } = req.body as {
    sessionId?: string;
    customers?: CustomerImportRow[];
    duplicateStrategy?: DuplicateStrategy;
  };

  if (!sessionId?.trim()) {
    return apiResponse.validationError(res, { sessionId: 'Session ID is required' });
  }
  if (!customers || !Array.isArray(customers) || customers.length === 0) {
    return apiResponse.validationError(res, { customers: 'Non-empty customers array is required' });
  }

  const strategy: DuplicateStrategy = duplicateStrategy ?? 'skip';
  const result = await importCustomers(companyId, sessionId, customers, strategy);

  log.info('Customers imported', {
    companyId,
    sessionId,
    imported: result.imported,
    skipped: result.skipped,
  }, 'migration');

  return apiResponse.success(res, result);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
