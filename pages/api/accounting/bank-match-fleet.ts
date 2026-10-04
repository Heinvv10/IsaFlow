/**
 * Bank Transaction → Fleet Cross-Module Linking API
 *
 * POST /api/accounting/bank-match-fleet
 *   Body: { bankTransactionId, fleetEntityType: 'fuel' | 'service', fleetEntityId }
 *
 * Links a bank transaction to either a fleet fuel transaction or a fleet
 * service history record, storing the reference on both sides and marking
 * the bank transaction as 'matched' when it was previously 'imported'.
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
  fleetEntityType: z.enum(['fuel', 'service']),
  fleetEntityId: UUID,
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

  const feedState = await readFeedState(companyId, bankTransactionId);
  if (feedState === null) return apiResponse.notFound(res, 'Bank transaction not found');
  if (feedState !== 'posted') {
    return apiResponse.conflict(res, new BankTransactionNotPostedError(bankTransactionId, feedState, 'link').message);
  }

  if (fleetEntityType === 'fuel') {
    // ── Fuel transaction link ──────────────────────────────────────────────
    await sql`
      UPDATE fleet_fuel_transactions
      SET bank_transaction_id = ${bankTransactionId}::UUID
      WHERE id = ${fleetEntityId}::UUID AND company_id = ${companyId}::UUID
    `;

    // D12 round 2: under the 5 s budget (the stale-stamp fragment's FOR SHARE on the session) — held -> 503.
    await underStampBudget(() => sql`
      UPDATE bank_transactions
      SET
        linked_fleet_fuel_id = ${fleetEntityId}::UUID,
        status = CASE WHEN status = 'imported' THEN 'matched' ELSE status END,
        reconciliation_id = CASE WHEN status = 'imported' THEN ${openStampOnly(companyId)} ELSE reconciliation_id END,
        updated_at = NOW()
      WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}
    `);

    log.info('Linked bank tx to fleet fuel', { bankTransactionId, fleetEntityId }, 'bank-match-fleet');
    return apiResponse.success(res, {
      linked: true,
      bankTransactionId,
      fleetEntityType: 'fuel',
      fleetEntityId,
    });
  }

  // ── Service history link ───────────────────────────────────────────────────
  await sql`
    UPDATE fleet_service_history
    SET bank_transaction_id = ${bankTransactionId}::UUID
    WHERE id = ${fleetEntityId}::UUID AND company_id = ${companyId}::UUID
  `;

  await underStampBudget(() => sql`
    UPDATE bank_transactions
    SET
      linked_fleet_service_id = ${fleetEntityId}::UUID,
      status = CASE WHEN status = 'imported' THEN 'matched' ELSE status END,
      reconciliation_id = CASE WHEN status = 'imported' THEN ${openStampOnly(companyId)} ELSE reconciliation_id END,
      updated_at = NOW()
    WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}
  `);

  log.info('Linked bank tx to fleet service', { bankTransactionId, fleetEntityId }, 'bank-match-fleet');
  return apiResponse.success(res, {
    linked: true,
    bankTransactionId,
    fleetEntityType: 'service',
    fleetEntityId,
  });
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
