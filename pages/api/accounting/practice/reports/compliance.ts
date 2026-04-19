/**
 * Compliance Report
 * GET /api/accounting/practice/reports/compliance?periodStart=...&periodEnd=...
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { getComplianceReport } from '@/modules/accounting/services/practice/practiceReportsService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const { periodStart, periodEnd } = req.query;
  if (!periodStart || !periodEnd) return apiResponse.badRequest(res, 'periodStart and periodEnd are required');
  const rows = await getComplianceReport(companyId, {
    periodStart: periodStart as string,
    periodEnd: periodEnd as string,
  });
  return apiResponse.success(res, rows);
}

export default withAuth(withErrorHandler(handler));
