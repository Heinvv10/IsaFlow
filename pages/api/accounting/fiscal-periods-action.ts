/**
 * Fiscal Period Actions API
 * POST /api/accounting/fiscal-periods-action - Close, lock, or reopen a period
 * Body: { id, action: 'close' | 'lock' | 'reopen', userId? }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  closePeriod,
  lockPeriod,
  reopenPeriod,
} from '@/modules/accounting/services/fiscalPeriodService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  try {
    const { id, action, userId } = req.body;
    if (!id || !action) {
      return apiResponse.badRequest(res, 'id and action are required');
    }

    let result;
    switch (action) {
      case 'close':
        if (!userId) return apiResponse.badRequest(res, 'userId required for close action');
        result = await closePeriod(id, userId);
        break;
      case 'lock':
        result = await lockPeriod(id);
        break;
      case 'reopen':
        result = await reopenPeriod(id);
        break;
      default:
        return apiResponse.badRequest(res, `Invalid action: ${action}. Use close, lock, or reopen`);
    }

    return apiResponse.success(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to perform period action';
    log.error('Failed to perform period action', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
