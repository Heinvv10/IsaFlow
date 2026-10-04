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
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { respondIfReconciliationCompleted } from '@/lib/apiReconciliationCompleted';
import { refuseJournalCashOfCompletedReconciliation } from '@/modules/accounting/services/bank/reconciledCash';
import { UUID } from '@/lib/schemas/common';
import {
  postJournalEntry,
  reverseJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import { assertNotImpersonating, respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';

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
        // R-032 L5: postJournalEntry is the posting primitive every workflow shares,
        // so the explicit "post this journal" act is guarded here, not inside it.
        await assertNotImpersonating();
        // A person posting: s16(3) late input-VAT claim where allowed; the
        // result's `lateClaim` names the claim date and the locked period.
        result = await postJournalEntry(companyId, id, userId, { allowLateInputClaim: true });
        break;
      case 'reverse':
        // D12: cash a COMPLETED bank reconciliation signed off is refused (409) at the entrance, its statement lines
        // locked first (bank -> GL), before reverseJournalEntry takes the journal.
        await refuseJournalCashOfCompletedReconciliation(companyId, id);
        result = await reverseJournalEntry(companyId, id, userId, { reversalDate });
        break;
      default:
        return apiResponse.badRequest(res, `Invalid action: ${action}. Use post or reverse`);
    }

    return apiResponse.success(res, result);
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    // A pay run's journal (`PayrollRunBusyError`: the guard's wait ran out before anything was written) and the
    // reversal's chain-head claim (D8) are held rows: 503 + Retry-After, not the 400 below.
    if (respondIfLockTimeout(res, err)) return;
    if (respondIfReconciliationCompleted(res, err)) return; // D12: raised before any write
    const message = err instanceof Error ? err.message : 'Failed to perform journal entry action';
    log.error('Failed to perform journal entry action', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
