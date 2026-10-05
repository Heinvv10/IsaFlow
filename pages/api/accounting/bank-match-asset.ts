/**
 * Bank Transaction → Asset link
 *
 * POST /api/accounting/bank-match-asset
 *   Body: { bankTransactionId, assetId }       — link the line to the asset (a fuel / service link is cleared)
 *         { bankTransactionId, assetId: null } — clear the line's asset link
 *
 * An ANNOTATION ONLY (mig 853, Hein 2026-10-05): writes the link columns, never the line's status, journal link or
 * reconciliation stamp, and posts nothing — so it is outside D12's completed-reconciliation rule (`bank/.claude.md`).
 * Before any write: the line in this company (404), the asset in this company (404 — one answer for missing and
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
  assetId: UUID.nullable(),
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
  const { bankTransactionId, assetId } = parsed.data;

  const result = await setBankLineLink(companyId, bankTransactionId, 'asset', assetId);
  if (!result.ok) return respondLinkRefusal(res, result, 'asset', bankTransactionId);

  log.info(assetId ? 'Linked bank tx to asset' : 'Unlinked bank tx from asset', { bankTransactionId, assetId }, 'bank-match-asset');

  return apiResponse.success(res, {
    linked: assetId !== null,
    bankTransactionId,
    assetId,
  });
}


export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
