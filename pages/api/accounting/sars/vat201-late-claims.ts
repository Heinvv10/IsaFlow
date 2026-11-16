/**
 * GET /api/accounting/sars/vat201-late-claims?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * The VAT201's late-claims section (vat201LateClaims): every s16(3) late input-VAT claim, and
 * reversal of one, dated in the period, with its original document and filed period. Read-only,
 * scoped to the caller's company; the total equals the late part of the input-tax boxes or the
 * service throws; the route answers 500 with the mismatch's own message (period and totals only). Rate-limited per user.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withNoStore } from '@/lib/auth/withNoStore';
import { log } from '@/lib/logger';
import { checkReportRateLimit, INTERACTIVE_REPORT_LIMIT } from '@/lib/rateLimit';
import { reportWindowProblem } from '@/lib/validation';
import { Vat201LateClaimsMismatchError, getVat201LateClaims } from '@/modules/accounting/services/reports/vat201LateClaims';

const MAX_WINDOW_DAYS = 400;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const { from, to } = req.query;
  if (typeof from !== 'string' || typeof to !== 'string') return apiResponse.badRequest(res, 'from and to are required (YYYY-MM-DD)');
  const windowProblem = reportWindowProblem(from, to);
  if (windowProblem) return apiResponse.badRequest(res, windowProblem);
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_WINDOW_DAYS) {
    return apiResponse.badRequest(res, `The window must not exceed ${MAX_WINDOW_DAYS} days`);
  }
  if (!(await checkReportRateLimit(companyId, `vat201-late-claims:u:${user.id}`, INTERACTIVE_REPORT_LIMIT))) {
    log.warn('VAT201 late-claims rate limit exceeded', { companyId, userId: user.id }, 'vat201-late-claims');
    return apiResponse.tooManyRequests(res, 'Too many requests. Please try again shortly.');
  }
  try {
    return apiResponse.success(res, await getVat201LateClaims(companyId, from, to));
  } catch (err) {
    if (!(err instanceof Vat201LateClaimsMismatchError)) throw err;
    // A fault, but its message is the period and the two totals only (no ids, no SQL): shown as is, in every env.
    log.error('VAT201 late claims do not tie to the input boxes', { companyId, from, to, message: err.message }, 'vat201-late-claims');
    return apiResponse.error(res, ErrorCode.INTERNAL_ERROR, err.message);
  }
}

export default withAuth(withNoStore(withErrorHandler(handler)));
