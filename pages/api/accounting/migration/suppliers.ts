/**
 * Migration Suppliers API
 * POST /api/accounting/migration/suppliers
 * Body: { sessionId, suppliers[], duplicateStrategy }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  importSuppliers,
  type SupplierImportRow,
  type DuplicateStrategy,
} from '@/modules/accounting/services/migrationContactService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const { sessionId, suppliers, duplicateStrategy } = req.body as {
    sessionId?: string;
    suppliers?: SupplierImportRow[];
    duplicateStrategy?: DuplicateStrategy;
  };

  if (!sessionId?.trim()) {
    return apiResponse.validationError(res, { sessionId: 'Session ID is required' });
  }
  if (!suppliers || !Array.isArray(suppliers) || suppliers.length === 0) {
    return apiResponse.validationError(res, { suppliers: 'Non-empty suppliers array is required' });
  }

  const strategy: DuplicateStrategy = duplicateStrategy ?? 'skip';
  const result = await importSuppliers(companyId, sessionId, suppliers, strategy);

  log.info('Suppliers imported', {
    companyId,
    sessionId,
    imported: result.imported,
    skipped: result.skipped,
  }, 'migration');

  return apiResponse.success(res, result);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
