/**
 * Year-End Processing API
 * GET  /api/accounting/year-end - List fiscal years with revenue/expense totals
 * GET  /api/accounting/year-end?preview=<yearLabel> - Read-only dry run of the close
 *      (net income, the Retained Earnings account, or the refusal the close would give)
 * POST /api/accounting/year-end - Close a fiscal year (action: "close", confirm: true)
 * Sage equivalent: Accountant's Area > Year-End
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { JOURNAL_DATE_REFUSED, withJournalDateRefusal } from '@/lib/apiJournalDate';
import { withAuth, type CompanyAuthedRequest, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withFlowMeter, markFlowNoOp } from '@/lib/billing/withFlowMeter';
import { getFlowCost } from '@/modules/billing/services/flowOperationCatalog';
import { log } from '@/lib/logger';
import { listFiscalYears, closeFiscalYear } from '@/modules/accounting/services/gl/yearEndService';
import { assertNotImpersonating, respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { isHeaderAccountRefusal } from '@/modules/accounting/services/gl/headerAccountGuard';
import { yearEndCloseRefusal, type YearEndCloseRefusal } from '@/lib/yearEndCloseRefusal';

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

function sendRefusal(res: NextApiResponse, refusal: YearEndCloseRefusal) {
  if (refusal.kind === 'notFound') return apiResponse.notFound(res, 'Fiscal year');
  if (refusal.kind === 'conflict') return apiResponse.conflict(res, refusal.message, refusal.details);
  return apiResponse.badRequest(res, refusal.message);
}

/**
 * What the close WOULD do, for the confirmation dialog. `closeFiscalYear` with
 * `dryRun` runs every guard and writes nothing. A typed refusal comes back as a
 * 200 `{ refusal }` so the dialog can show it and keep Confirm disabled.
 */
async function previewHandler(req: NextApiRequest, res: NextApiResponse, yearLabel: string) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const result = await closeFiscalYear(companyId, yearLabel, userId, { dryRun: true });
  if ('error' in result) {
    return apiResponse.success(res, { yearLabel, refusal: yearEndCloseRefusal(result).message });
  }
  if (!('dryRun' in result)) {
    log.error('Year-end preview answered without a dry run', { yearLabel, module: 'accounting' });
    return apiResponse.badRequest(res, 'Year-end preview could not be read.');
  }
  if (result.alreadyClosed) {
    return apiResponse.success(res, { yearLabel, alreadyClosed: true, netIncome: result.netIncome });
  }
  // yearEndJournalBuilder.buildPreview appends the Retained Earnings line LAST,
  // and only when the rounded result is non-zero (a break-even year transfers nothing).
  const { preview } = result;
  const reLine = preview.lines.length > 0 && Math.round(result.netIncome * 100) !== 0
    ? preview.lines[preview.lines.length - 1]!
    : null;
  return apiResponse.success(res, {
    yearLabel,
    alreadyClosed: false,
    netIncome: result.netIncome,
    entryDate: preview.entryDate,
    entryNumber: preview.entryNumber,
    retainedEarnings: reLine ? { accountCode: reLine.accountCode, accountName: reLine.accountName } : null,
  });
}

async function getHandler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const preview = req.query?.preview;
  if (typeof preview === 'string' && preview.length > 0) return previewHandler(req, res, preview);
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
    const result = await withJournalDateRefusal(res, () => closeFiscalYear(companyId, String(yearLabel), userId));
    if (result === JOURNAL_DATE_REFUSED) return;

    if ('error' in result) {
      const refusal = yearEndCloseRefusal(result);
      return sendRefusal(res, refusal);
    }

    // A re-run of an already-closed year is a 200 that writes NOTHING: no
    // journal, no lock, no ledger movement. Metering it would bill a retry
    // loop — the MCP timeout-retry K-113 records as the live trigger — once
    // per attempt for one close.
    if (result.alreadyClosed) markFlowNoOp(req);
    return apiResponse.success(res, result);
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    // The retained-earnings leg on a balance-sheet header (D1): postClosingJournal asks before its first INSERT.
    if (isHeaderAccountRefusal(err)) return apiResponse.badRequest(res, err.message);
    log.error('Failed to process year-end', { error: err, yearLabel, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to process year-end');
  }
}

const meteredPost = withFlowMeter('yearend.close', getFlowCost('yearend.close'))(postHandler);

async function mux(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') {
    // R-032 L5: refused before the PAYG meter debits (and refunds) the wallet.
    await assertNotImpersonating();
    // Audit P3.2: the close posts a whole year's result to equity and locks every
    // period, so it needs an explicit `confirm: true` (strict boolean). Refused
    // before the meter, so an unconfirmed call is never billed.
    if ((req.body as { confirm?: unknown } | undefined)?.confirm !== true) {
      return apiResponse.badRequest(res, 'Year-end close needs explicit confirmation. Send confirm: true.');
    }
    return meteredPost(req, res);
  }
  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}


export default withAuth(withRole('admin')(withErrorHandler(withCsrf(mux))));
