/**
 * Currencies API
 * GET  — list currencies
 * POST — create currency
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { getCurrencies, createCurrency, toggleCurrency } from '@/modules/accounting/services/currencyService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const activeOnly = req.query.active !== 'false';
    const currencies = await getCurrencies(activeOnly);
    return apiResponse.success(res, currencies);
  }

  if (req.method === 'POST') {
    const { code, name, symbol, decimalPlaces } = req.body;
    if (!code || !name || !symbol) return apiResponse.badRequest(res, 'code, name, symbol required');
    const currency = await createCurrency({ code, name, symbol, decimalPlaces });
    return apiResponse.success(res, currency);
  }

  if (req.method === 'PUT') {
    const { code, isActive } = req.body;
    if (!code) return apiResponse.badRequest(res, 'code required');
    await toggleCurrency(code, isActive !== false);
    return apiResponse.success(res, { updated: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
