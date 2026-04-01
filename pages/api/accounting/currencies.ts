/**
 * Currencies API
 * GET  — list currencies
 * POST — create currency
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { getCurrencies, createCurrency, toggleCurrency } from '@/modules/accounting/services/currencyService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const activeOnly = req.query.active !== 'false';
    const currencies = await getCurrencies(companyId, activeOnly);
    return apiResponse.success(res, currencies);
  }

  if (req.method === 'POST') {
    const { code, name, symbol, decimalPlaces } = req.body;
    if (!code || !name || !symbol) return apiResponse.badRequest(res, 'code, name, symbol required');
    const currency = await createCurrency(companyId, { code, name, symbol, decimalPlaces });
    return apiResponse.success(res, currency);
  }

  if (req.method === 'PUT') {
    const { code, isActive } = req.body;
    if (!code) return apiResponse.badRequest(res, 'code required');
    await toggleCurrency(companyId, code, isActive !== false);
    return apiResponse.success(res, { updated: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
