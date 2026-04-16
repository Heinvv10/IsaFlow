/**
 * GET /api/accounting/afs/[documentId]/pis-score
 * Returns the Public Interest Score for an AFS document, computed from live GL data.
 * Includes dataUnavailable warnings for stubbed fields (employee_count, shareholder_count).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { computePisScoreForDocument } from '@/modules/accounting/services/afs/pisCalculatorService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const { documentId } = req.query;

  if (typeof documentId !== 'string') {
    return apiResponse.badRequest(res, 'documentId is required');
  }

  const pisScore = await computePisScoreForDocument(companyId, documentId);
  return apiResponse.success(res, pisScore);
}

export default withCompany(withErrorHandler(handler as never));
