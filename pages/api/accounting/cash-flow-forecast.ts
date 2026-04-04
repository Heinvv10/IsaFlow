/**
 * Cash Flow Forecast API
 * GET — generate cash flow forecast for the next N months
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { generateForecast, getHistoricalForChart } from '@/modules/accounting/services/cashFlowForecastService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const months = Math.max(1, Math.min(Number(req.query.months) || 6, 24));
  const threshold = Math.max(0, Number(req.query.threshold) || 0);
  const includeHistory = req.query.history !== 'false';

  try {
    const [forecast, historical] = await Promise.all([
      generateForecast(companyId, months, threshold),
      includeHistory ? getHistoricalForChart(companyId, 6) : Promise.resolve([]),
    ]);

    return apiResponse.success(res, {
      ...forecast,
      historical,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Cash flow forecast failed';
    return apiResponse.internalError(res, err, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
