/**
 * Credit Note Actions API
 * POST /api/accounting/credit-notes-action
 *   action: approve
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { approveCreditNote, cancelCreditNote } from '@/modules/accounting/services/creditNoteService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  try {
    const { action, creditNoteId, reason } = req.body;
    const userId = req.user.id;

    if (!action || !creditNoteId) {
      return apiResponse.badRequest(res, 'action and creditNoteId are required');
    }

    switch (action) {
      case 'approve': {
        const creditNote = await approveCreditNote(creditNoteId, userId);
        return apiResponse.success(res, creditNote);
      }
      case 'cancel': {
        const cancelled = await cancelCreditNote(creditNoteId, userId, reason);
        return apiResponse.success(res, cancelled);
      }
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Action failed';
    log.error('Credit note action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
