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
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as never))));
