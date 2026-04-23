/**
 * POST /api/accounting/ar/disputes/[id]/resolve
 *
 * Resolves an open dispute. Three modes (user-choice):
 *   resolve_with_credit → auto-creates a customer credit note for
 *                         disputed_amount (requires creditDate).
 *   resolve_no_credit   → status=resolved, no credit, amount re-ages.
 *   rejected            → status=rejected, no credit, amount re-ages.
 *
 * PRD-06 Phase 3. Company-scoped, auth-required.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { resolveDispute } from '@/modules/accounting/services/ar/disputeService';

type ResolveMode = 'resolve_with_credit' | 'resolve_no_credit' | 'rejected';
const ALLOWED_MODES: ResolveMode[] = ['resolve_with_credit', 'resolve_no_credit', 'rejected'];

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
  const mode = typeof body.mode === 'string' ? body.mode : '';
  const note = typeof body.note === 'string' ? body.note.trim() : undefined;
  const creditDate = typeof body.creditDate === 'string' ? body.creditDate : undefined;

  if (!(ALLOWED_MODES as string[]).includes(mode)) {
    apiResponse.badRequest(res, `mode must be one of: ${ALLOWED_MODES.join(', ')}`);
    return;
  }
  if (mode === 'resolve_with_credit' && !creditDate) {
    apiResponse.badRequest(res, 'creditDate is required when resolving with credit');
    return;
  }

  try {
    const dispute = await resolveDispute(companyId, id, user.id, {
      mode: mode as ResolveMode,
      note,
      creditDate,
    });
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

export default withAuth(withErrorHandler(withWriteAccess(handler)));
