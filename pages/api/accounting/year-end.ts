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
import { isSuppliedApprovalRefusal } from '@/modules/accounting/services/controls/approvalExecutionService';

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

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (month: number) => MONTHS[month - 1] ?? `month ${month}`;

/** API callers can supply approvalId; the year-end screen cannot send one yet. */
function approvalRequiredMessage(yearLabel: string): string {
  return `An independent approval is required to close financial year ${yearLabel} under the company's approval ` +
    'policy, so nothing was closed. An API caller can request one and retry with its approvalId; the year-end ' +
    'screen cannot apply an approval yet, so this close cannot be completed from that screen.';
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
        case 'approval_required':
          // Not a success: the close cannot run until an independent approval
          // is supplied as approvalId.
          return apiResponse.conflict(res, approvalRequiredMessage(String(yearLabel)));
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
        case 'period_range_mismatch':
          // Refuses on every production company today (gl/.claude.md). It was
          // answered 200, which the year-end screen reported as a completed close.
          return apiResponse.conflict(res,
            `Fiscal year ${String(yearLabel)}'s periods run ${result.actual.startDate} to ${result.actual.endDate}, ` +
              `but this company's financial year starts in ${monthName(result.startMonth)}, so the year runs ` +
              `${result.expected.startDate} to ${result.expected.endDate}. Closing the periods as they stand would ` +
              'roll the wrong twelve months into retained earnings and lock them, so nothing was closed. The fiscal ' +
              'periods must be aligned with the financial year first — a data correction for a company owner or admin to decide.');
        default: {
          // A new outcome must be mapped here; it can never fall through to 200.
          const unmapped: never = result;
          throw new Error(`Unmapped year-end outcome: ${(unmapped as { error: string }).error}`);
        }
      }
    }

    return apiResponse.success(res, result);
  } catch (err) {
    // The live close raises the kernel's approval refusal (the preview returns
    // it); either way it is a refusal the caller can act on, not a 500.
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
    if (code === 'OPERATION_APPROVAL_REQUIRED') {
      return apiResponse.conflict(res, approvalRequiredMessage(String(yearLabel)));
    }
    // A supplied approvalId this close cannot use is the caller's mistake, and
    // the control message says which mistake it is.
    if (isSuppliedApprovalRefusal(err)) {
      return apiResponse.conflict(res,
        `The approval supplied for financial year ${String(yearLabel)} cannot be used to close it ` +
          `(${err instanceof Error ? err.message : 'approval unusable'}). Nothing was closed. Request an approval for ` +
          'this exact close and retry with its approvalId.');
    }
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
