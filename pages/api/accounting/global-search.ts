/**
 * Global Search API — WS-3.1
 * GET /api/accounting/global-search?q=<term>&limit=<n>
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { mayReadPayroll } from '@/lib/auth/payrollReadGate';
import { globalSearch } from '@/modules/accounting/services/core/globalSearchService';
import { searchPages } from '@/modules/accounting/services/core/pageSearch';

const MAX_QUERY_LENGTH = 100;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  try {
    const { q, limit } = req.query;
    const query = typeof q === 'string' ? q.trim() : '';
    if (query.length > MAX_QUERY_LENGTH) {
      return apiResponse.badRequest(res, `Search text must be ${MAX_QUERY_LENGTH} characters or fewer`);
    }
    const parsedLimit = limit ? Math.min(Number(limit), 30) : 8;

    if (query.length < 2) {
      return apiResponse.success(res, { results: [] });
    }

    log.info('Global search', { companyId, query, limit: parsedLimit }, 'global-search-api');

    // Pages first (at most 3): "sage" or "import" found nothing when only records were searched.
    const pages = searchPages(query, Math.min(3, parsedLimit));
    // An employee's name and number are Payroll's: found only by someone who may read Payroll (#1656, round 7).
    // census-exempt(globalSearch): employees are searched only with includeEmployees, the Payroll read answer on the next line; nothing else it searches is payroll
    const records = await globalSearch(companyId, query, parsedLimit, { includeEmployees: await mayReadPayroll(companyId, user.id) });
    const results = [...pages, ...records].slice(0, parsedLimit);

    return apiResponse.success(res, { results });
  } catch (err) {
    log.error('Global search API failed', { error: err }, 'global-search-api');
    return apiResponse.badRequest(res, 'Search failed');
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
