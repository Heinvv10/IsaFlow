/**
 * Bank Transaction → Fleet record link
 *
 * POST /api/accounting/bank-match-fleet
 *   Body: { bankTransactionId, fleetEntityType: 'fuel' | 'service', fleetEntityId }
 *         — link the line to a fuel or service record of an asset (any other link on the line is cleared);
 *         { bankTransactionId, fleetEntityType, fleetEntityId: null } — clear that kind's link.
 *
 * An ANNOTATION ONLY (mig 853, Hein 2026-10-05): writes the link columns, never the line's status, journal link or
 * reconciliation stamp, and posts nothing — so it is outside D12's completed-reconciliation rule (`bank/.claude.md`).
 * Before any write: the line in this company (404), the record in this company (404 — one answer for missing and
 * another company's), the line posted at the bank (409). See `bankAssetLinkService`.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { setBankLineLink } from '@/modules/accounting/services/bank/bankAssetLinkService';
import { respondLinkRefusal } from '@/modules/accounting/services/bank/bankAssetLinkRefusal';

const BodySchema = z.object({
  bankTransactionId: UUID,
  fleetEntityType: z.enum(['fuel', 'service']),
  fleetEntityId: UUID.nullable(),
}).strict();

// ── Handler ───────────────────────────────────────────────────────────────────

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const { bankTransactionId, fleetEntityType, fleetEntityId } = parsed.data;

  const result = await setBankLineLink(companyId, bankTransactionId, fleetEntityType, fleetEntityId);
  if (!result.ok) return respondLinkRefusal(res, result, fleetEntityType, bankTransactionId);

  log.info(fleetEntityId ? 'Linked bank tx to fleet record' : 'Unlinked bank tx from fleet record',
    { bankTransactionId, fleetEntityType, fleetEntityId }, 'bank-match-fleet');
  return apiResponse.success(res, {
    linked: fleetEntityId !== null,
    bankTransactionId,
    fleetEntityType,
    fleetEntityId,
  });
}


export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
