/**
 * Exchange Rate Convert API
 * POST — convert an amount between two currencies using the company's rates
 *
 * Body: { amount, fromCurrency, toCurrency, date? }
 * Returns: { result, rate, effectiveDate }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { convertAmount as convertAmountPure } from '@/modules/accounting/services/core/multiCurrencyService';
import { getLatestRate, getExchangeRates } from '@/modules/accounting/services/core/currencyService';
import { log } from '@/lib/logger';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { companyId } = req;

  const { amount, fromCurrency, toCurrency, date } = req.body as {
    amount: unknown;
    fromCurrency: unknown;
    toCurrency: unknown;
    date?: unknown;
  };

  // Validate required fields
  if (amount === undefined || amount === null) {
    return apiResponse.badRequest(res, 'amount is required');
  }
  if (!fromCurrency || typeof fromCurrency !== 'string' || fromCurrency.trim() === '') {
    return apiResponse.badRequest(res, 'fromCurrency is required');
  }
  if (!toCurrency || typeof toCurrency !== 'string' || toCurrency.trim() === '') {
    return apiResponse.badRequest(res, 'toCurrency is required');
  }

  const numAmount = Number(amount);
  if (isNaN(numAmount)) {
    return apiResponse.badRequest(res, 'amount must be a valid number');
  }

  const from = String(fromCurrency).toUpperCase().trim();
  const to = String(toCurrency).toUpperCase().trim();

  // Same-currency shortcut — no DB lookup needed
  if (from === to) {
    return apiResponse.success(res, {
      result: numAmount,
      rate: 1,
      effectiveDate: date ? String(date) : new Date().toISOString().split('T')[0],
    });
  }

  // Validate date format if provided
  const asOfDate = date ? String(date) : undefined;
  if (asOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    return apiResponse.badRequest(res, 'date must be in YYYY-MM-DD format');
  }

  const resolvedDate = asOfDate ?? new Date().toISOString().split('T')[0]!;

  // Look up the most recent applicable rate from the DB
  const rate = await getLatestRate(companyId, from, to, resolvedDate);

  if (rate === null) {
    log.warn('Exchange rate not found for conversion', {
      companyId, from, to, date: resolvedDate,
    }, 'accounting');
    return apiResponse.notFound(res, 'Exchange rate', `${from}/${to} on or before ${resolvedDate}`);
  }

  // Determine the actual effectiveDate of the rate we used
  const rateRows = await getExchangeRates(companyId, { fromCurrency: from, toCurrency: to, limit: 1 });
  const effectiveDate = rateRows[0]?.effectiveDate ?? resolvedDate;

  // Delegate computation to the pure service function
  const result = convertAmountPure(numAmount, from, to, rate);

  log.info('Currency conversion', {
    companyId, from, to, amount: numAmount, rate, result,
  }, 'accounting');

  return apiResponse.success(res, { result, rate, effectiveDate });
}

export default withAuth(withErrorHandler(handler));
