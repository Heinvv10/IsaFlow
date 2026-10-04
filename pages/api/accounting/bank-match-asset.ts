/**
 * Bank Transaction → Asset Cross-Module Linking API
 *
 * POST /api/accounting/bank-match-asset
 *   Body: { bankTransactionId, assetId }
 *
 * Links a bank transaction to an asset record, storing the reference on
 * both sides and marking the bank transaction as 'matched' when it was
 * previously 'imported'.
 *
 * D12: the link ids are annotations — outside the "a completed reconciliation is immutable" rule
 * (`bank/.claude.md`). The status turn clears a completed session's stale stamp and runs under the 5 s
 * budget. No migration creates the link schema (register item; see `pages/api/accounting/assets/.claude.md`).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { readFeedState, BankTransactionNotPostedError } from '@/modules/accounting/services/bank/bankFeedStateGuard';
import { openStampOnly, underStampBudget } from '@/modules/accounting/services/bank/reconciliationSessionLock';

const BodySchema = z.object({
  bankTransactionId: UUID,
  assetId: UUID,
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

  const feedState = await readFeedState(companyId, bankTransactionId);
  if (feedState === null) return apiResponse.notFound(res, 'Bank transaction not found');
  if (feedState !== 'posted') {
    return apiResponse.conflict(res, new BankTransactionNotPostedError(bankTransactionId, feedState, 'link').message);
  }

  // ── Write reverse link on the asset ───────────────────────────────────────
  await sql`
    UPDATE assets
    SET bank_transaction_id = ${bankTransactionId}::UUID
    WHERE id = ${assetId}::UUID AND company_id = ${companyId}::UUID
  `;

  // ── Write forward link on the bank transaction ─────────────────────────────
  // D12 round 2: under the 5 s budget (the stale-stamp fragment's FOR SHARE on the session) — held -> 503.
  await underStampBudget(() => sql`
    UPDATE bank_transactions
    SET
      linked_asset_id = ${assetId}::UUID,
      status = CASE WHEN status = 'imported' THEN 'matched' ELSE status END,
      reconciliation_id = CASE WHEN status = 'imported' THEN ${openStampOnly(companyId)} ELSE reconciliation_id END,
      updated_at = NOW()
    WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}
  `);

  log.info('Linked bank tx to asset', { bankTransactionId, assetId }, 'bank-match-asset');

  return apiResponse.success(res, {
    linked: true,
    bankTransactionId,
    assetId,
  });
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
