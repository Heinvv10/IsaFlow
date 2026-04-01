/**
 * Exchange Rates API
 * GET  — list rates (optional from/to currency filters)
 * POST — set/update rate for a date
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import {
  getExchangeRates,
  setExchangeRate,
  getLatestRate,
  convertAmount,
} from '@/modules/accounting/services/currencyService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    const { from, to, convert, amount, date } = req.query;

    // Convert endpoint: ?convert=true&from=USD&to=ZAR&amount=100&date=2026-02-26
    if (convert === 'true' && from && to && amount) {
      const result = await convertAmount(companyId,
        Number(amount), String(from), String(to), date ? String(date) : undefined
      );
      if (!result) return apiResponse.notFound(res, 'Exchange rate', `${from}/${to}`);
      return apiResponse.success(res, result);
    }

    // Latest rate: ?from=USD&to=ZAR&latest=true
    if (req.query.latest === 'true' && from && to) {
      const rate = await getLatestRate(companyId, String(from), String(to), date ? String(date) : undefined);
      if (rate === null) return apiResponse.notFound(res, 'Exchange rate', `${from}/${to}`);
      return apiResponse.success(res, { from, to, rate });
    }

    // List rates
    const rates = await getExchangeRates(companyId, {
      fromCurrency: from ? String(from) : undefined,
      toCurrency: to ? String(to) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    return apiResponse.success(res, rates);
  }

  if (req.method === 'POST') {
    const { fromCurrency, toCurrency, rate, effectiveDate, source } = req.body;
    if (!fromCurrency || !toCurrency || !rate || !effectiveDate) {
      return apiResponse.badRequest(res, 'fromCurrency, toCurrency, rate, effectiveDate required');
    }
    const result = await setExchangeRate(companyId,
      { fromCurrency, toCurrency, rate: Number(rate), effectiveDate, source },
      userId
    );
    return apiResponse.success(res, result);
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
