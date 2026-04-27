// pages/api/accounting/afs-mapping/accounts.ts
// GET    — list mapped accounts (+ unmapped via ?unmapped=true)
// PUT    — map single account { glAccountId, afsLineCode }
// DELETE — unmap account { glAccountId }

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import {
  getAccountMappings,
  getUnmappedAccounts,
  mapAccount,
  unmapAccount,
} from '@/modules/accounting/services/afs/afsMappingService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  if (req.method === 'GET') {
    const unmapped = req.query.unmapped === 'true';
    if (unmapped) {
      const accounts = await getUnmappedAccounts(companyId);
      return apiResponse.success(res, accounts);
    }
    const mappings = await getAccountMappings(companyId);
    return apiResponse.success(res, mappings);
  }

  if (req.method === 'PUT') {
    const { glAccountId, afsLineCode } = req.body ?? {};
    if (!glAccountId || !afsLineCode) {
      return apiResponse.badRequest(res, 'glAccountId and afsLineCode are required');
    }
    const mapping = await mapAccount(companyId, glAccountId, afsLineCode);
    return apiResponse.success(res, mapping, 'Account mapped');
  }

  if (req.method === 'DELETE') {
    const { glAccountId } = req.body ?? {};
    if (!glAccountId) {
      return apiResponse.badRequest(res, 'glAccountId is required');
    }
    await unmapAccount(companyId, glAccountId);
    return apiResponse.success(res, null, 'Account unmapped');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
