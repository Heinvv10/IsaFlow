// pages/api/accounting/afs-mapping/bulk.ts
// POST — bulk map accounts { mappings: [{ glAccountId, afsLineCode }] }

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { bulkMapAccounts } from '@/modules/accounting/services/afs/afsMappingService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);

  const { companyId } = req;
  const { mappings } = req.body ?? {};

  if (!Array.isArray(mappings) || mappings.length === 0) {
    return apiResponse.badRequest(res, 'mappings array is required');
  }

  for (const m of mappings) {
    if (!m.glAccountId || !m.afsLineCode) {
      return apiResponse.badRequest(res, 'Each mapping needs glAccountId and afsLineCode');
    }
  }

  const count = await bulkMapAccounts(companyId, mappings);
  return apiResponse.success(res, { count }, `${count} accounts mapped`);
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
