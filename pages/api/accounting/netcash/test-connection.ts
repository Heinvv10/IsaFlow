/**
 * POST /api/accounting/netcash/test-connection
 * Tests the service key against the Netcash API.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { testConnection } from '@/modules/accounting/services/ap/netcashService';
import { log } from '@/lib/logger';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { serviceKey } = req.body as { serviceKey?: string };
  if (!serviceKey) return apiResponse.badRequest(res, 'serviceKey is required');

  const result = await testConnection(serviceKey);

  log.info('Netcash connection test', { valid: result.valid, mock: result.mock ?? false }, 'netcash-api');

  return apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withAuth>[0]));
