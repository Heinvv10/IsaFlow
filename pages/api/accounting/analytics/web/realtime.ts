import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { getRealtime } from '@/modules/analytics/services/queryService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  const websiteId = (req.query.website_id as string) || '';
  if (!websiteId) return apiResponse.badRequest(res, 'website_id required');
  const data = await getRealtime(websiteId, req.companyId);
  if (!data) return apiResponse.notFound(res, 'website');
  return apiResponse.success(res, data);
}

export default withAuth(withErrorHandler(handler));
