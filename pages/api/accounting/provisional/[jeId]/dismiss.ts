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
    return apiResponse.success(res, result, 'Provisional entry reversed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to dismiss provisional entry';
    if (/not found/i.test(msg)) return apiResponse.notFound(res, 'Journal entry', jeId);
    if (/not provisional/i.test(msg)) return apiResponse.badRequest(res, msg);
    // Double-dismiss race (second tab / rapid retry): reverseJournalEntry's
    // own guard throws — a friendly 400 beats an opaque 500.
    if (/already reversed/i.test(msg)) return apiResponse.badRequest(res, 'Journal entry already reversed');
    // A provenance refusal is a business answer, not a fault: this journal is not a provisional entry the controlled
    // reversal can prove an original for (no bank row names it, it is not provisional any more, or something hangs off
    // it). The caller can act on that; a 500 tells them nothing.
    if (/provenance cannot be proven|names this provisional journal/i.test(msg)) return apiResponse.badRequest(res, msg);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as never))));
