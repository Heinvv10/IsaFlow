/**
 * 13-week cash forecast (cash13 PR 1).
 * GET → { today, weeks[13], lines[], overdueAR, warnings[] }. Money in integer cents (signed: + in, − out);
 * the page renders rand. Today is the app's SAST day. Read-only, GET only; rate-limited per company like the
 * other heavy report reads (it reads the AR/AP books, the SARS returns, every loan schedule and the budget).
 * A source the database cannot read comes back as a `source_unavailable` warning, not a 500; the opening
 * balance is the exception — without it there is no forecast, so 503 with a plain message.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { appToday } from '@/modules/accounting/services/reports/dueByDateService';
import { CashForecastUnavailableError, getCashForecast13 } from '@/modules/accounting/services/cashForecast13/cashForecast13Service';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  if (!(await checkReportRateLimit(companyId, 'cash-forecast-13'))) {
    log.warn('Cash forecast rate limit exceeded', { companyId }, 'rateLimit');
    return apiResponse.tooManyRequests(res, 'Too many forecast requests. Please try again shortly.');
  }
  try {
    return apiResponse.success(res, await getCashForecast13(companyId, appToday()));
  } catch (err) {
    if (!(err instanceof CashForecastUnavailableError)) throw err;
    log.warn('Cash forecast refused: opening cash unreadable', { companyId }, 'cashForecast13');
    return apiResponse.error(res, ErrorCode.SERVICE_UNAVAILABLE, err.message, { code: err.code });
  }
}

export default withAuth(withErrorHandler(handler));
