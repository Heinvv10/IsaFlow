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
import { z } from 'zod';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { ArRequestError, withdrawDispute } from '@/modules/accounting/services/ar/disputeService';

const BodySchema = z.object({
  note: z.string().trim().max(2000).optional(),
}).strict();

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
  const { note } = parsed.data;

  try {
    const dispute = await withdrawDispute(companyId, id, user.id, note);
    apiResponse.success(res, dispute);
  } catch (err) {
    // Typed, not text-matched — see the note in resolve.ts.
    if (err instanceof ArRequestError) {
      apiResponse.badRequest(res, err.message);
      return;
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
