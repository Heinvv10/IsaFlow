/**
 * Fiscal Period Actions API
 * POST /api/accounting/fiscal-periods-action
 * Body: { id?, ids?, action, fiscalYear? }
 *
 * Single-id actions: 'close' | 'lock' | 'reopen'  (require `id`)
 * Bulk actions:      'bulk_close' | 'bulk_lock' | 'bulk_reopen'  (require `ids`)
 * Year-level action: 'close_year'  (requires `fiscalYear`)
 *
 * Bulk paths process each id sequentially and return { results: [{ id, ok, error? }] }
 * so the caller can show partial-success state. We DO NOT abort on the first
 * failure — the user's expectation in the UI is "do as much as you can".
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withRole } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  closePeriod,
  lockPeriod,
  reopenPeriod,
  closeYear,
} from '@/modules/accounting/services/gl/fiscalPeriodService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const { id, ids, action, fiscalYear } = req.body as {
      id?: string;
      ids?: unknown;
      action?: string;
      fiscalYear?: unknown;
    };

    if (!action) {
      return apiResponse.badRequest(res, 'action is required');
    }

    // Use authenticated user ID — never trust userId from request body
    const userId = (req as AuthenticatedNextApiRequest).user.id;

    const bulkOp = (
      action === 'bulk_close' ? (id: string) => closePeriod(companyId, id, userId)
      : action === 'bulk_lock' ? (id: string) => lockPeriod(companyId, id)
      : action === 'bulk_reopen' ? (id: string) => reopenPeriod(companyId, id)
      : null
    );
    if (bulkOp) {
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((v): v is string => typeof v === 'string' && v.length > 0)) {
        return apiResponse.badRequest(res, 'ids (non-empty array of strings) is required for bulk actions');
      }
      // Cap to prevent runaway loops; 60 covers 5 fiscal years of monthly periods.
      if (ids.length > 60) {
        return apiResponse.badRequest(res, 'bulk action limit is 60 periods per request');
      }
      const results: Array<{ id: string; ok: boolean; error?: string }> = [];
      for (const periodId of ids) {
        try {
          await bulkOp(periodId);
          results.push({ id: periodId, ok: true });
        } catch (err) {
          results.push({ id: periodId, ok: false, error: err instanceof Error ? err.message : 'Failed' });
        }
      }
      const okCount = results.filter(r => r.ok).length;
      log.info('Bulk fiscal period action', { action, total: ids.length, ok: okCount }, 'accounting-api');
      return apiResponse.success(res, { results, okCount, total: ids.length });
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
    const message = err instanceof Error ? err.message : 'Failed to perform period action';
    log.error('Failed to perform period action', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

export default withAuth(withRole('admin')(withErrorHandler(withCsrf(handler))));
