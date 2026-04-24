import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { getRealtime } from '@/modules/analytics/services/queryService';
import type { PlatformAdminRequest } from '@/lib/auth';

async function handler(req: PlatformAdminRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  const websiteId = (req.query.website_id as string) || '';
  if (!websiteId) return apiResponse.badRequest(res, 'website_id required');
  const data = await getRealtime(websiteId);
  if (!data) return apiResponse.notFound(res, 'website');
  return apiResponse.success(res, data);
}

export default withAdmin(handler);
