/**
 * Fiscal Period Actions API
 * POST /api/accounting/fiscal-periods-action
 * Body: { id?, ids?, action, fiscalYear?, confirm? }
 *
 * close, lock, bulk_close, bulk_lock and close_year need `confirm: true`
 * (strict boolean; audit P3.2): they post at once and lock is permanent.
 * reopen and bulk_reopen do not.
 *
 * Single-id actions: 'close' | 'lock' | 'reopen'  (require `id`)
 * Bulk actions:      'bulk_close' | 'bulk_lock' | 'bulk_reopen'  (require `ids`)
 * Year-level action: 'close_year'  (requires `fiscalYear`)
 *
 * Bulk paths (gl/fiscalPeriodBulk.ts) lock every id up front in period order,
 * run each in its own savepoint and return { results: [{ id, ok, error? }] } so
 * the caller can show partial success: a REFUSED period does not stop the rest.
 *
 * Close, Bulk Close, Close Year, Lock and Bulk Lock go through the readiness
 * gate (`gl/periodCloseGate.ts`). A refused close, lock or close_year answers
 * 409 with `error.details = { code: 'PERIOD_CLOSE_NOT_READY', fiscalYear?,
 * periods: [{ periodId, periodName, blockers: [{ key, label, reason, fixHref }] }] }`;
 * a refused bulk period carries `code` and `periods` on its result row.
 * A period another request holds (lock wait ran out, or a deadlock) is 503 +
 * Retry-After and the whole request rolls back, bulk included.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withRole } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { isCallerSafeError } from '@/lib/lockTimeout';
import {
  closePeriod,
  lockPeriod,
  reopenPeriod,
  closeYear,
} from '@/modules/accounting/services/gl/fiscalPeriodService';
import { runBulkPeriodAction, type BulkPeriodAction } from '@/modules/accounting/services/gl/fiscalPeriodBulk';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { closeRefusalDetails, isCloseRefusal } from '@/modules/accounting/services/gl/periodCloseErrors';

const CONFIRM_REQUIRED = new Set(['close', 'lock', 'bulk_close', 'bulk_lock', 'close_year']);
const BULK = new Set<string>(['bulk_close', 'bulk_lock', 'bulk_reopen']);

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  let bulk = false;

  try {
    const { id, ids, action, fiscalYear, confirm } = req.body as {
      id?: string;
      ids?: unknown;
      action?: string;
      fiscalYear?: unknown;
      confirm?: unknown;
    };

    if (!action) {
      return apiResponse.badRequest(res, 'action is required');
    }

    if (CONFIRM_REQUIRED.has(action) && confirm !== true) {
      return apiResponse.badRequest(res, `The ${action} action needs explicit confirmation. Send confirm: true.`);
    }

    // Use authenticated user ID — never trust userId from request body
    const userId = (req as AuthenticatedNextApiRequest).user.id;

    if (BULK.has(action)) {
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((v): v is string => typeof v === 'string' && v.length > 0)) {
        return apiResponse.badRequest(res, 'ids (non-empty array of strings) is required for bulk actions');
      }
      // Cap to prevent runaway loops; 60 covers 5 fiscal years of monthly periods.
      if (ids.length > 60) {
        return apiResponse.badRequest(res, 'bulk action limit is 60 periods per request');
      }
      bulk = true;
      return apiResponse.success(res, await runBulkPeriodAction(companyId, action as BulkPeriodAction, ids, userId));
    }

    let result;
    switch (action) {
      case 'close':
        if (!id) return apiResponse.badRequest(res, 'id is required for close action');
        result = await closePeriod(companyId, id, userId);
        break;
      case 'lock':
        if (!id) return apiResponse.badRequest(res, 'id is required for lock action');
        result = await lockPeriod(companyId, id);
        break;
      case 'reopen':
        if (!id) return apiResponse.badRequest(res, 'id is required for reopen action');
        result = await reopenPeriod(companyId, id);
        break;
      case 'close_year':
        if (fiscalYear === undefined || fiscalYear === null || isNaN(Number(fiscalYear))) {
          return apiResponse.badRequest(res, 'fiscalYear is required for close_year action');
        }
        result = await closeYear(companyId, Number(fiscalYear), userId);
        break;
      default:
        return apiResponse.badRequest(res, `Invalid action: ${action}. Use close, lock, reopen, close_year, bulk_close, bulk_lock, or bulk_reopen`);
    }

    return apiResponse.success(res, result);
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    // Written nothing: the gate refuses before the UPDATE.
    if (isCloseRefusal(err)) return apiResponse.conflict(res, err.message, { ...closeRefusalDetails(err) });
    // A held period: 503 + Retry-After, and the request (a bulk's earlier periods too) rolls back.
    if (respondIfLockTimeout(res, err)) return;
    // A driver error (it carries a SQLSTATE) is a fault, not a refusal: rethrown, it is a 500 and the
    // request rolls back whole. A 4xx would COMMIT whatever an earlier bulk period wrote. A bulk run
    // answers every refusal as a result row, so anything else it throws is a fault too, typed or not.
    if (bulk || !isCallerSafeError(err)) throw err;
    log.warn('Fiscal period action refused', { error: err.message }, 'accounting-api');
    return apiResponse.badRequest(res, err.message);
  }
}

export default withAuth(withRole('admin')(withErrorHandler(withCsrf(handler))));
