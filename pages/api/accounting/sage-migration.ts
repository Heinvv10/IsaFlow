/**
 * Sage Migration API
 * GET  /api/accounting/sage-migration              — migration status dashboard
 * GET  /api/accounting/sage-migration?view=mappings — account mappings list
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import {
  getMigrationStatus,
  getAccountMappings,
} from '@/modules/accounting/services/sageMigrationService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);
  }

  const view = String(req.query.view || 'status');

  if (view === 'mappings') {
    const mappings = await getAccountMappings();
    return apiResponse.success(res, mappings);
  }

  const status = await getMigrationStatus();
  return apiResponse.success(res, status);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
