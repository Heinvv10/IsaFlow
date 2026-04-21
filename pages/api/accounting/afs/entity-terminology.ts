// pages/api/accounting/afs/entity-terminology.ts
// GET — Fetch entity terminology for the current company
// Returns full terminology map + disclosure requirements

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { getCompanyTerminology, getDisclosureRequirements } from '@/modules/accounting/services/afs/entityTerminology';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);

  const { companyId } = req;
  const terms = await getCompanyTerminology(companyId);
  const disclosures = getDisclosureRequirements(terms.entityType);

  return apiResponse.success(res, { terminology: terms, disclosures });
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
