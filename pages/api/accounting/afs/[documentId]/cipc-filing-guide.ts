/**
 * GET /api/accounting/afs/[documentId]/cipc-filing-guide
 * Returns the CIPC filing guide for an AFS document including deadline,
 * required forms, documents checklist, and next step.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { generateCipcFilingGuide } from '@/modules/accounting/services/afs/cipcFilingGuideService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const { documentId } = req.query;

  if (typeof documentId !== 'string') {
    return apiResponse.badRequest(res, 'documentId is required');
  }

  const guide = await generateCipcFilingGuide(companyId, documentId);
  return apiResponse.success(res, guide);
}

export default withCompany(withErrorHandler(handler as never));
