// pages/api/accounting/afs-mapping/auto-map.ts
// POST — run auto-mapping heuristic on unmapped GL accounts

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { autoMapAccounts } from '@/modules/accounting/services/afs/afsMappingService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);

  const { companyId } = req;
  const result = await autoMapAccounts(companyId);
  return apiResponse.success(res, result, `Mapped ${result.mapped} accounts automatically`);
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
