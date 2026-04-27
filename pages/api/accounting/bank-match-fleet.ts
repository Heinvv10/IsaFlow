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
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

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

  if (fleetEntityType === 'fuel') {
    // ── Fuel transaction link ──────────────────────────────────────────────
    await sql`
      UPDATE fleet_fuel_transactions
      SET bank_transaction_id = ${bankTransactionId}::UUID
      WHERE id = ${fleetEntityId}::UUID AND company_id = ${companyId}::UUID
    `;

    await sql`
      UPDATE bank_transactions
      SET
        linked_fleet_fuel_id = ${fleetEntityId}::UUID,
        status = CASE WHEN status = 'imported' THEN 'matched' ELSE status END,
        updated_at = NOW()
      WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}
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
    WHERE id = ${fleetEntityId}::UUID AND company_id = ${companyId}::UUID
  `;

  await sql`
    UPDATE bank_transactions
    SET
      linked_fleet_service_id = ${fleetEntityId}::UUID,
      status = CASE WHEN status = 'imported' THEN 'matched' ELSE status END,
      updated_at = NOW()
    WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}
  `;

  log.info('Linked bank tx to fleet service', { bankTransactionId, fleetEntityId }, 'bank-match-fleet');
  return apiResponse.success(res, {
    linked: true,
    bankTransactionId,
    fleetEntityType: 'service',
    fleetEntityId,
  });
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
