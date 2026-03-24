/**
 * Bank Transaction → Fleet Cross-Module Linking API
 *
 * POST /api/accounting/bank-match-fleet
 *   Body: { bankTransactionId, fleetEntityType: 'fuel' | 'service', fleetEntityId }
 *
 * Links a bank transaction to either a fleet fuel transaction or a fleet
 * service history record, storing the reference on both sides and marking
 * the bank transaction as 'matched' when it was previously 'imported'.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

// ── Types ─────────────────────────────────────────────────────────────────────

type FleetEntityType = 'fuel' | 'service';

interface PostBody {
  bankTransactionId?: string;
  fleetEntityType?: FleetEntityType;
  fleetEntityId?: string;
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { bankTransactionId, fleetEntityType, fleetEntityId } = req.body as PostBody;

  // ── Validation ─────────────────────────────────────────────────────────────
  if (!bankTransactionId) return apiResponse.badRequest(res, 'bankTransactionId is required');
  if (!fleetEntityId) return apiResponse.badRequest(res, 'fleetEntityId is required');
  if (!fleetEntityType || !['fuel', 'service'].includes(fleetEntityType)) {
    return apiResponse.badRequest(res, "fleetEntityType must be 'fuel' or 'service'");
  }

  if (fleetEntityType === 'fuel') {
    // ── Fuel transaction link ──────────────────────────────────────────────
    await sql`
      UPDATE fleet_fuel_transactions
      SET bank_transaction_id = ${bankTransactionId}::UUID
      WHERE id = ${fleetEntityId}::UUID
    `;

    await sql`
      UPDATE bank_transactions
      SET
        linked_fleet_fuel_id = ${fleetEntityId}::UUID,
        status = CASE WHEN status = 'imported' THEN 'matched' ELSE status END,
        updated_at = NOW()
      WHERE id = ${bankTransactionId}::UUID
    `;

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
    WHERE id = ${fleetEntityId}::UUID
  `;

  await sql`
    UPDATE bank_transactions
    SET
      linked_fleet_service_id = ${fleetEntityId}::UUID,
      status = CASE WHEN status = 'imported' THEN 'matched' ELSE status END,
      updated_at = NOW()
    WHERE id = ${bankTransactionId}::UUID
  `;

  log.info('Linked bank tx to fleet service', { bankTransactionId, fleetEntityId }, 'bank-match-fleet');
  return apiResponse.success(res, {
    linked: true,
    bankTransactionId,
    fleetEntityType: 'service',
    fleetEntityId,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
