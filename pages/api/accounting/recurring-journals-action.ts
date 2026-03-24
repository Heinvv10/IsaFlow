/**
 * Recurring Journal Actions API
 * POST — pause, resume, cancel, generate
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  updateRecurringJournalStatus,
  generateJournalFromRecurring,
} from '@/modules/accounting/services/recurringJournalService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  try {
    const { action, id } = req.body;
    const userId = req.user.id;
    if (!action || !id) return apiResponse.badRequest(res, 'action and id are required');

    switch (action) {
      case 'pause':
        await updateRecurringJournalStatus(id, 'paused');
        return apiResponse.success(res, { status: 'paused' });
      case 'resume':
        await updateRecurringJournalStatus(id, 'active');
        return apiResponse.success(res, { status: 'active' });
      case 'cancel':
        await updateRecurringJournalStatus(id, 'cancelled');
        return apiResponse.success(res, { status: 'cancelled' });
      case 'generate': {
        const journalId = await generateJournalFromRecurring(id, userId);
        return apiResponse.success(res, { journalId });
      }
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Action failed';
    log.error('Recurring journal action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, msg);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
