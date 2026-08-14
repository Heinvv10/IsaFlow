/**
 * Exchange Rates API
 * GET  — list rates (optional from/to currency filters)
 * POST — set/update rate for a date
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { clampLimit } from '@/lib/pagination';
import {
  getExchangeRates,
  setExchangeRate,
  getLatestRate,
  convertAmount,
  deleteExchangeRate,
} from '@/modules/accounting/services/core/currencyService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
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
      limit: clampLimit(req.query.limit, 100, 1000),
    });
    return apiResponse.success(res, rates);
  }

  if (req.method === 'POST') {
    const { fromCurrency, toCurrency, rate, effectiveDate, source } = req.body;
    if (!fromCurrency || !toCurrency || !rate || !effectiveDate) {
      return apiResponse.badRequest(res, 'fromCurrency, toCurrency, rate, effectiveDate required');
    }
    const numRate = Number(rate);
    if (isNaN(numRate) || numRate <= 0) {
      return apiResponse.badRequest(res, 'Exchange rate must be a positive number');
    }
    const result = await setExchangeRate(companyId,
      { fromCurrency, toCurrency, rate: numRate, effectiveDate, source },
      userId
    );
    return apiResponse.success(res, result);
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id || typeof id !== 'string') {
      return apiResponse.badRequest(res, 'id query parameter is required');
    }
    await deleteExchangeRate(companyId, id);
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'DELETE']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
