/**
 * Sage Migration API
 * GET  /api/accounting/sage-migration              — migration status dashboard
 * GET  /api/accounting/sage-migration?view=mappings — account mappings list
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import {
  getMigrationStatus,
  getAccountMappings,
} from '@/modules/accounting/services/sageMigrationService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const view = String(req.query.view || 'status');

  if (view === 'mappings') {
    const mappings = await getAccountMappings(companyId);
    return apiResponse.success(res, mappings);
  }

  const status = await getMigrationStatus(companyId);
  return apiResponse.success(res, status);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
