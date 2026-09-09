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
import { UUID_RE } from '@/lib/validation';
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
  const { yearLabel, action, approvalId, dryRun } = req.body;

  if (action !== 'close') {
    return apiResponse.badRequest(res, 'Only "close" action is supported');
  }

  if (!yearLabel) {
    return apiResponse.validationError(res, { yearLabel: 'Fiscal year label required' });
  }

  if ((approvalId !== undefined && (typeof approvalId !== 'string' || !UUID_RE.test(approvalId)))
    || (dryRun !== undefined && typeof dryRun !== 'boolean')) return apiResponse.badRequest(res, 'Invalid year-close approval or preview option');

  try {
    const result = await closeFiscalYear(companyId, String(yearLabel), userId, {
      ...(approvalId === undefined ? {} : { approvalId }), ...(dryRun === undefined ? {} : { dryRun }),
    });

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
  if (req.method === 'POST') return req.body?.dryRun === true ? postHandler(req, res) : meteredPost(req, res);
  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}


export default withAuth(withRole('admin')(withErrorHandler(withCsrf(mux))));
