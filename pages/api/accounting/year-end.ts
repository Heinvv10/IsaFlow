/**
 * Year-End Processing API
 * GET  /api/accounting/year-end - List fiscal years with revenue/expense totals
 * POST /api/accounting/year-end - Close a fiscal year (action: "close")
 * Sage equivalent: Accountant's Area > Year-End
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withFlowMeter } from '@/lib/billing/withFlowMeter';
import { getFlowCost } from '@/modules/billing/services/flowOperationCatalog';
import { log } from '@/lib/logger';
import { listFiscalYears, closeFiscalYear } from '@/modules/accounting/services/gl/yearEndService';

/**
 * Postgres "undefined_table" / "undefined_column" SQLSTATEs. Schema-not-ready
 * is the only failure mode that should resolve to an empty 200 + setupRequired
 * hint — every other DB error must surface as a real 500 so monitoring fires.
 */
const SCHEMA_MISSING_CODES = new Set(['42P01', '42703']);

function isSchemaMissingError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && SCHEMA_MISSING_CODES.has(code);
}

async function getHandler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  try {
    const years = await listFiscalYears(companyId);
    return apiResponse.success(res, { years });
  } catch (err) {
    log.error('Failed to fetch fiscal years', { error: err, module: 'accounting' });
    if (isSchemaMissingError(err)) {
      // Specific known case: the fiscal_periods table or one of its columns
      // doesn't exist in this environment yet. Return an empty list with a
      // setupRequired hint so the page renders an actionable empty state.
      return apiResponse.success(res, {
        years: [],
        setupRequired: 'Fiscal periods schema is not yet provisioned for this company. Configure fiscal periods in Accounts > Fiscal Periods.',
      });
    }
    // Anything else (connection pool exhaustion, permission errors, etc.)
    // is a genuine infrastructure failure — surface as 500 so monitoring
    // catches it.
    return apiResponse.databaseError(res, err, 'Failed to fetch fiscal years');
  }
}

async function postHandler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
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
            'No Retained Earnings system account is configured. Mark the equity ' +
              "account as a system account with account_subtype 'retained_earnings', " +
              'then run the year-end close again.'
          );
        case 'ambiguous_retained_earnings':
          return apiResponse.badRequest(
            res,
            `More than one account is flagged as the Retained Earnings system account ` +
              `(${result.accountCodes.join(', ')}). Year-end close posts the whole year's ` +
              `result to one account, so it will not guess — un-flag all but one and try again.`
          );
        case 'no_fiscal_period':
          return apiResponse.badRequest(
            res,
            `No fiscal period covers ${result.entryDate}, where the closing journal has to ` +
              `land. Create the period that covers the last day of the year, then close again.`
          );
        case 'period_range_mismatch':
          return apiResponse.badRequest(
            res,
            `The periods labelled this fiscal year run ${result.actual.startDate} to ` +
              `${result.actual.endDate}, but this company's financial year starts in month ` +
              `${result.startMonth}, so the year is ${result.expected.startDate} to ` +
              `${result.expected.endDate}. Closing the labelled span would roll the wrong ` +
              `twelve months into equity and lock them. Fix the period dates, then close again.`
          );
        case 'closing_journal_not_posted':
          return apiResponse.conflict(
            res,
            `This year already has a closing journal (${result.entryNumber}) and it is `
              + `${result.status}, not posted. The year is therefore NOT closed, but it also `
              + `cannot be closed again while that entry holds the number. Delete or renumber `
              + `journal ${result.entryId}, then close the year.`
          );
        default: {
          // Exhaustive over CloseYearError: `unhandled` stops being `never` the
          // moment a member is added without a case. Without this the refusal
          // fell through to the success response below and the route answered
          // 200 with an `error` body — which is exactly what `no_fiscal_period`
          // and `period_range_mismatch` did.
          const unhandled: never = result;
          log.error('Year-end close refused with an unhandled error shape',
            { unhandled, yearLabel, module: 'accounting' });
          return apiResponse.badRequest(res, 'Year-end close was refused.');
        }
      }
    }

    return apiResponse.success(res, result);
  } catch (err) {
    log.error('Failed to process year-end', { error: err, yearLabel, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to process year-end');
  }
}

const meteredPost = withFlowMeter('yearend.close', getFlowCost('yearend.close'))(postHandler);

async function mux(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return meteredPost(req, res);
  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}


export default withAuth(withRole('admin')(withErrorHandler(withCsrf(mux))));
