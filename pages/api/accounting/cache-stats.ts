/**
 * WS-5.1: Cache Stats API
 * GET  /api/accounting/cache-stats  — Returns cache hit/miss statistics (admin only)
 * POST /api/accounting/cache-stats  — Clears all cache entries (admin only)
 *                                     Body: { action: "clear" }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { cache } from '@/lib/cache';

const ADMIN_ROLES = ['owner', 'admin', 'super_admin'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyApiRequest;

  if (!ADMIN_ROLES.includes(companyRole)) {
    return apiResponse.forbidden(res, 'Only admins can view or manage cache statistics.');
  }

  if (req.method === 'GET') {
    const stats = cache.stats();
    log.info('Cache stats requested', { companyId, stats }, 'cache');
    return apiResponse.success(res, stats);
  }

  if (req.method === 'POST') {
    const { action } = req.body as { action?: string };
    if (action !== 'clear') {
      return apiResponse.badRequest(res, 'Invalid action. Supported: "clear"');
    }
    cache.clear();
    log.info('Cache cleared via API', { companyId }, 'cache');
    return apiResponse.success(res, { cleared: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
