/**
 * POST /api/accounting/ar/disputes/[id]/withdraw
 *
 * Marks an open dispute as withdrawn. Used by internal users on behalf of
 * a customer (e.g. customer phoned to drop it) — portal-side withdrawal is
 * not in Phase 3 scope.
 *
 * PRD-06 Phase 3.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withdrawDispute } from '@/modules/accounting/services/ar/disputeService';

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method !== 'POST') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
    return;
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    apiResponse.badRequest(res, 'Dispute id is required');
    return;
  }

  const body = req.body ?? {};
  const note = typeof body.note === 'string' ? body.note.trim() : undefined;

  try {
    const dispute = await withdrawDispute(companyId, id, user.id, note);
    apiResponse.success(res, dispute);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not open/i.test(message) || /not found/i.test(message)) {
      apiResponse.badRequest(res, message);
      return;
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
