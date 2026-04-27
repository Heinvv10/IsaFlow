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
import { z } from 'zod';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { resolveDispute } from '@/modules/accounting/services/ar/disputeService';

const BodySchema = z.object({
  mode: z.enum(['resolve_with_credit', 'resolve_no_credit', 'rejected']),
  note: z.string().trim().max(2000).optional(),
  creditDate: z.string().max(30).optional(),
}).refine(
  v => !(v.mode === 'resolve_with_credit' && !v.creditDate),
  { message: 'creditDate is required when resolving with credit', path: ['creditDate'] },
);

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method !== 'POST') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
    return;
  }

  const idParse = UUID.safeParse(req.query.id);
  if (!idParse.success) {
    apiResponse.badRequest(res, 'Dispute id must be a valid UUID');
    return;
  }
  const id = idParse.data;

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    return;
  }
  const { mode, note, creditDate } = parsed.data;

  try {
    const dispute = await resolveDispute(companyId, id, user.id, {
      mode,
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

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
