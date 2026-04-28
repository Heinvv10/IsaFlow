// pages/api/accounting/afs-mapping/accounts.ts
// GET    — list mapped accounts (+ unmapped via ?unmapped=true)
// PUT    — map single account { glAccountId, afsLineCode }
// DELETE — unmap account { glAccountId }

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { apiResponse } from '@/lib/apiResponse';
import {
  getAccountMappings,
  getUnmappedAccounts,
  mapAccount,
  unmapAccount,
} from '@/modules/accounting/services/afs/afsMappingService';

const MapAccountSchema = z.object({
  glAccountId: UUID,
  afsLineCode: z.string().min(1).max(50),
}).strict();

const UnmapAccountSchema = z.object({
  glAccountId: UUID,
}).strict();

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
    const parsed = MapAccountSchema.safeParse(req.body);
    if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
    const mapping = await mapAccount(companyId, parsed.data.glAccountId, parsed.data.afsLineCode);
    return apiResponse.success(res, mapping, 'Account mapped');
  }

  if (req.method === 'DELETE') {
    const parsed = UnmapAccountSchema.safeParse(req.body);
    if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
    await unmapAccount(companyId, parsed.data.glAccountId);
    return apiResponse.success(res, null, 'Account unmapped');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
