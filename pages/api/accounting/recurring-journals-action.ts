/**
 * Recurring Journal Actions API
 * POST — pause, resume, cancel, generate
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  updateRecurringJournalStatus,
  generateJournalFromRecurring,
} from '@/modules/accounting/services/gl/recurringJournalService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const { action, id } = req.body;
    const userId = req.user.id;
    if (!action || !id) return apiResponse.badRequest(res, 'action and id are required');

    switch (action) {
      case 'pause':
        await updateRecurringJournalStatus(companyId, id, 'paused');
        return apiResponse.success(res, { status: 'paused' });
      case 'resume':
        await updateRecurringJournalStatus(companyId, id, 'active');
        return apiResponse.success(res, { status: 'active' });
      case 'cancel':
        await updateRecurringJournalStatus(companyId, id, 'cancelled');
        return apiResponse.success(res, { status: 'cancelled' });
      case 'generate': {
        const journalId = await generateJournalFromRecurring(companyId, id, userId);
        return apiResponse.success(res, { journalId });
      }
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    log.error('Recurring journal action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequestFromError(res, err, 'Action failed');
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
