/**
 * SARS EMP201 API
 * GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD — generate EMP201 data for period
 * POST { periodStart, periodEnd }     — save as draft submission
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { isValidDate } from '@/lib/validation';
import {
  generateEMP201,
  saveDraftSubmission,
} from '@/modules/accounting/services/sarsService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    const from = req.query.from as string;
    const to = req.query.to as string;

    if (!from || !to) {
      return apiResponse.badRequest(res, 'from and to query parameters are required (YYYY-MM-DD)');
    }
    if (!isValidDate(from) || !isValidDate(to)) {
      return apiResponse.badRequest(res, 'from and to must be valid dates in YYYY-MM-DD format');
    }

    try {
      const emp201 = await generateEMP201(companyId, from, to);
      return apiResponse.success(res, emp201);
    } catch (err) {
      log.error('Failed to generate EMP201', { error: err }, 'sars-api');
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Failed to generate EMP201');
    }
  }

  if (req.method === 'POST') {
    const { periodStart, periodEnd } = req.body;

    if (!periodStart || !periodEnd) {
      return apiResponse.badRequest(res, 'periodStart and periodEnd are required');
    }
    if (!isValidDate(periodStart) || !isValidDate(periodEnd)) {
      return apiResponse.badRequest(res, 'periodStart and periodEnd must be valid dates in YYYY-MM-DD format');
    }

    try {
      const emp201 = await generateEMP201(companyId, periodStart, periodEnd);
      const submission = await saveDraftSubmission(
        companyId,
        'EMP201',
        periodStart,
        periodEnd,
        emp201 as unknown as Record<string, unknown>,
        userId
      );
      return apiResponse.created(res, submission, 'EMP201 draft saved');
    } catch (err) {
      log.error('Failed to save EMP201 draft', { error: err }, 'sars-api');
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Failed to save draft');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
