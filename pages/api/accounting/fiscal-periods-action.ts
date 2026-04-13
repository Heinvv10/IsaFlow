/**
 * Fiscal Period Actions API
 * POST /api/accounting/fiscal-periods-action
 * Body: { id?, action: 'close' | 'lock' | 'reopen' | 'close_year', fiscalYear? }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest, withRole } from '@/lib/auth';
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

  const { companyId } = req as CompanyApiRequest;

  try {
    const { id, action, fiscalYear } = req.body as {
      id?: string;
      action?: string;
      fiscalYear?: unknown;
    };

    if (!action) {
      return apiResponse.badRequest(res, 'action is required');
    }

    // Use authenticated user ID — never trust userId from request body
    const userId = (req as AuthenticatedNextApiRequest).user.id;

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
        return apiResponse.badRequest(res, `Invalid action: ${action}. Use close, lock, reopen, or close_year`);
    }

    return apiResponse.success(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to perform period action';
    log.error('Failed to perform period action', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

export default withCompany(withRole('admin')(withErrorHandler(handler)));
