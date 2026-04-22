/**
 * Loan Schedule API
 * GET  — get or compute schedule (cached)
 * POST — preview schedule dry-run (with optional events override, not persisted)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withCsrf } from '@/lib/auth/withCsrf';
import { getOrComputeSchedule, previewSchedule } from '@/modules/accounting/services/loans/loanScheduleService';
import type { LoanEvent } from '@/lib/amortisation/types';
import { isValidUUID } from '@/lib/validation';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const loanId = String(req.query.id ?? '');
  if (!isValidUUID(loanId)) return apiResponse.notFound(res, 'Loan', loanId);

  if (req.method === 'GET') {
    const result = await getOrComputeSchedule(companyId, loanId);
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const { events } = req.body as { events?: LoanEvent[] };
    const rows = await previewSchedule(companyId, loanId, events);
    return apiResponse.success(res, { rows });
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
