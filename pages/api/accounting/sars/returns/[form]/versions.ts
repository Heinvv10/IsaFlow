/**
 * GET /api/accounting/sars/returns/[form]/versions?periodStart=&periodEnd=  (form = vat201 | emp201)
 * Every version of the return with its drift (re-generated now vs finalised), whether its VAT lock
 * was removed outside the lifecycle, and the vat_returns record beside it. Read-only.
 * Stored figures carry directive totals only, never per-payment rows. The period may span 366 days at most.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { reportWindowProblem } from '@/lib/validation';
import { listVersions } from '@/modules/accounting/services/returns/returnDrift';
import { returnFormOf } from '@/modules/accounting/services/returns/returnForm';

const MAX_SPAN_DAYS = 366;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const form = returnFormOf(req.query.form);
  if (!form) return apiResponse.notFound(res, 'Return form');
  const { periodStart, periodEnd } = req.query;
  if (typeof periodStart !== 'string' || typeof periodEnd !== 'string') {
    return apiResponse.badRequest(res, 'periodStart and periodEnd are required (YYYY-MM-DD)');
  }
  const problem = reportWindowProblem(periodStart, periodEnd);
  if (problem) return apiResponse.badRequest(res, problem);
  if (Date.parse(periodEnd) - Date.parse(periodStart) > MAX_SPAN_DAYS * 86_400_000) {
    return apiResponse.badRequest(res, `The period may span at most ${MAX_SPAN_DAYS} days`);
  }
  const { companyId } = req as CompanyAuthedRequest;
  return apiResponse.success(res, await listVersions(companyId, form, periodStart, periodEnd));
}

export default withAuth(withErrorHandler(handler));
