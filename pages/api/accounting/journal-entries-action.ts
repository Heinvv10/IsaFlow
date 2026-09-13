/**
 * Journal Entry Actions API
 * POST /api/accounting/journal-entries-action - Post or reverse an entry
 * Body: { id, action: 'post' | 'reverse', reversal_date?: 'YYYY-MM-DD' }
 *
 * reversal_date applies to 'reverse' only. Omitted, the reversal takes the
 * original entry's date when that period is open and today when it is closed.
 */

import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import { ErrorCode } from '@/lib/apiResponse.types';
import {
  postJournalEntry,
  reverseJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import { isPostingRefusal, GeneratedJournalOperationError } from '@/modules/accounting/services/gl/journalEntryPostingService';

const JournalEntryActionSchema = z.object({
  id: UUID,
  action: z.enum(['post', 'reverse']),
  /**
   * SHAPE ONLY. This regex accepts `2026-02-30` — it matches the pattern and is
   * not a day. Calendar validity, "not before the entry it reverses" and
   * "target period open" are all enforced downstream by reverseJournalEntry and
   * postJournalEntry, which are the only code that knows which entry is being
   * reversed. Duplicating any of that here would give the API and the service
   * two answers that can drift; the message below says so rather than implying
   * this layer is the whole check.
   */
  reversal_date: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}$/,
      'reversal_date must look like YYYY-MM-DD (the date is validated in full when the reversal is posted)',
    )
    .optional(),
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
    const { id, action, reversal_date: reversalDate } = parsed.data;
    const userId = req.user.id;

    let result;
    switch (action) {
      case 'post':
        result = await postJournalEntry(companyId, id, userId);
        break;
      case 'reverse':
        result = await reverseJournalEntry(companyId, id, userId, { reversalDate });
        break;
      default:
        return apiResponse.badRequest(res, `Invalid action: ${action}. Use post or reverse`);
    }

    return apiResponse.success(res, result);
  } catch (err) {
    // A lockdown or closed-period refusal for a direct post/reverse is now thrown by the kernel
    // (journalControlService.ts) BEFORE it opens the controlled write, so it reaches here as an ordinary business
    // error rather than a poisoned control transaction (see runJournalControl).
    if (isPostingRefusal(err)) return apiResponse.error(res, ErrorCode.BUSINESS_RULE_VIOLATION, (err as Error).message);
    // A journal a generated family owns is not postable or reversible from here: the kernel refuses it before the
    // controlled write, and the answer names the source so the caller knows which operation to use instead.
    if (err instanceof GeneratedJournalOperationError) return apiResponse.error(res, ErrorCode.BUSINESS_RULE_VIOLATION, err.message);
    const message = err instanceof Error ? err.message : 'Failed to perform journal entry action';
    log.error('Failed to perform journal entry action', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
