// pages/api/accounting/afs-mapping/stats.ts
// GET — mapping coverage stats

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { getMappingStats } from '@/modules/accounting/services/afs/afsMappingService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const stats = await getMappingStats(req.companyId);
  return apiResponse.success(res, stats);
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
