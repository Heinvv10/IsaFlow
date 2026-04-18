/**
 * Journal Entry Actions API
 * POST /api/accounting/journal-entries-action - Post or reverse an entry
 * Body: { id, action: 'post' | 'reverse' }
 */

import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import {
  postJournalEntry,
  reverseJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';

const JournalEntryActionSchema = z.object({
  id: UUID,
  action: z.enum(['post', 'reverse']),
});

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  const parsed = JournalEntryActionSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }

  try {
    const { id, action } = parsed.data;
    const userId = req.user.id;

    let result;
    switch (action) {
      case 'post':
        result = await postJournalEntry(companyId, id, userId);
        break;
      case 'reverse':
        result = await reverseJournalEntry(companyId, id, userId);
        break;
      default:
        return apiResponse.badRequest(res, `Invalid action: ${action}. Use post or reverse`);
    }

    return apiResponse.success(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to perform journal entry action';
    log.error('Failed to perform journal entry action', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
