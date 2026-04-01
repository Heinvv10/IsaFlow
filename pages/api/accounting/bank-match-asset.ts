/**
 * Bank Transaction → Asset Cross-Module Linking API
 *
 * POST /api/accounting/bank-match-asset
 *   Body: { bankTransactionId, assetId }
 *
 * Links a bank transaction to an asset record, storing the reference on
 * both sides and marking the bank transaction as 'matched' when it was
 * previously 'imported'.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PostBody {
  bankTransactionId?: string;
  assetId?: string;
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const { bankTransactionId, assetId } = req.body as PostBody;

  // ── Validation ─────────────────────────────────────────────────────────────
  if (!bankTransactionId) return apiResponse.badRequest(res, 'bankTransactionId is required');
  if (!assetId) return apiResponse.badRequest(res, 'assetId is required');

  // ── Write reverse link on the asset ───────────────────────────────────────
  await sql`
    UPDATE assets
    SET bank_transaction_id = ${bankTransactionId}::UUID
    WHERE id = ${assetId}::UUID
  `;

  // ── Write forward link on the bank transaction ─────────────────────────────
  await sql`
    UPDATE bank_transactions
    SET
      linked_asset_id = ${assetId}::UUID,
      status = CASE WHEN status = 'imported' THEN 'matched' ELSE status END,
      updated_at = NOW()
    WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}
  `;

  log.info('Linked bank tx to asset', { bankTransactionId, assetId }, 'bank-match-asset');

  return apiResponse.success(res, {
    linked: true,
    bankTransactionId,
    assetId,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
