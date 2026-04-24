import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { listWebsites } from '@/modules/analytics/services/queryService';
import type { PlatformAdminRequest } from '@/lib/auth';

async function handler(req: PlatformAdminRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  const websites = await listWebsites();
  return apiResponse.success(res, { websites });
}

export default withAdmin(handler);
