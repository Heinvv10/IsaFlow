/**
 * POST /api/accounting/afs/[documentId]/compliance-check
 * Runs all IFRS compliance checks against the document and returns a ComplianceResult.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { runComplianceCheck } from '@/modules/accounting/services/afs/complianceCheckerService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { documentId } = req.query;

  if (typeof documentId !== 'string') {
    return apiResponse.badRequest(res, 'documentId is required');
  }

  const result = await runComplianceCheck(companyId, documentId);
  return apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(handler as never));
