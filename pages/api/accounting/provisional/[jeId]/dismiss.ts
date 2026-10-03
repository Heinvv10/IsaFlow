/**
 * POST /api/accounting/provisional/[jeId]/dismiss
 *
 * Dismiss a provisional bank-posted JE: reverses the journal (net-zero
 * contra) and returns any linked bank transaction to the review queue.
 * Replaces the audit-flagged "automatic reversal is not yet implemented"
 * toast (A–Z P3.5).
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { dismissProvisionalEntry } from '@/modules/accounting/services/bank/provisionalDismissService';
import { ClosedFiscalPeriodError, VatPeriodLockedError } from '@/modules/accounting/services/gl/journalEntryService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  const { companyId } = req;
  const userId = req.user.id;
  const jeId = req.query.jeId as string;
  if (!jeId) return apiResponse.badRequest(res, 'jeId is required');

  try {
    const result = await dismissProvisionalEntry(companyId, jeId, userId);
    // Nothing was reversed when the journal's reversal chain was already out
    // of the ledger (D8): say that, rather than claim a reversal.
    return apiResponse.success(res, result, result.reversalJournalEntryId
      ? 'Provisional entry reversed'
      : 'Provisional entry dismissed; its journal was already out of the ledger');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to dismiss provisional entry';
    if (/not found/i.test(msg)) return apiResponse.notFound(res, 'Journal entry', jeId);
    if (/not provisional/i.test(msg)) return apiResponse.badRequest(res, msg);
    // Double-dismiss race (second tab / rapid retry): reverseJournalEntry's
    // own guard throws — a friendly 400 beats an opaque 500.
    if (/already reversed/i.test(msg)) return apiResponse.badRequest(res, 'Journal entry already reversed');
    // The contra cannot be dated into an open, unlocked period — including a
    // reversal that would precede a future-dated entry (R-012's
    // ReversalBeforeOriginalError IS-A ClosedFiscalPeriodError). The reversal
    // runs before the service's own write, and reverseJournalEntry deletes its
    // draft and releases its claim on failure, so the ledger is untouched. A
    // fiscal year createJournalEntry auto-created on the way (a post-time
    // refusal) does commit under this 400 — harmless, and correct on its own.
    if (err instanceof ClosedFiscalPeriodError || err instanceof VatPeriodLockedError) {
      return apiResponse.badRequest(res, msg);
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as never))));
