/**
 * Year-End Processing API
 * GET  /api/accounting/year-end - List fiscal years with revenue/expense totals
 * POST /api/accounting/year-end - Close a fiscal year (action: "close")
 * Sage equivalent: Accountant's Area > Year-End
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { listFiscalYears, closeFiscalYear } from '@/modules/accounting/services/yearEndService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const years = await listFiscalYears(companyId);
      return apiResponse.success(res, { years });
    } catch (err) {
      log.error('Failed to fetch fiscal years', { error: err, module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to fetch fiscal years');
    }
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const userId = (req as AuthenticatedNextApiRequest).user.id;
    const { yearLabel, action } = req.body;

    if (action !== 'close') {
      return apiResponse.badRequest(res, 'Only "close" action is supported');
    }

    if (!yearLabel) {
      return apiResponse.validationError(res, { yearLabel: 'Fiscal year label required' });
    }

    try {
      const result = await closeFiscalYear(companyId, String(yearLabel), userId);

      if ('error' in result) {
        switch (result.error) {
          case 'open_periods':
            return apiResponse.badRequest(
              res,
              `${result.count} periods still open. Close all periods first.`
            );
          case 'year_not_found':
            return apiResponse.notFound(res, 'Fiscal year');
          case 'no_retained_earnings':
            return apiResponse.badRequest(
              res,
              `Retained Earnings account not found (${result.accountCode}). Create the account or set 'retained_earnings_account' in app_settings.`
            );
        }
      }

      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to process year-end', { error: err, yearLabel, module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to process year-end');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withRole('admin')(withErrorHandler(handler)));
