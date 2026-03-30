/**
 * Global Search API — WS-3.1
 * GET /api/accounting/global-search?q=<term>&limit=<n>
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { globalSearch, getQuickActions } from '@/modules/accounting/services/globalSearchService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  try {
    const { q, limit } = req.query;
    const query = typeof q === 'string' ? q.trim() : '';
    const parsedLimit = limit ? Math.min(Number(limit), 30) : 8;

    const actions = getQuickActions();

    if (query.length < 2) {
      return apiResponse.success(res, { results: [], actions });
    }

    log.info('Global search', { companyId, query, limit: parsedLimit }, 'global-search-api');

    const results = await globalSearch(companyId, query, parsedLimit);

    return apiResponse.success(res, { results, actions });
  } catch (err) {
    log.error('Global search API failed', { error: err }, 'global-search-api');
    return apiResponse.badRequest(res, 'Search failed');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
