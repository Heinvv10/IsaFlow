/**
 * Manual Bank Transaction API — Spend Money / Receive Money
 * POST /api/accounting/bank-transactions-manual
 * Equivalent to Sage "Create Transaction" in Process Bank.
 *
 * Inserts a bank_transaction record and immediately allocates it
 * via the existing allocateTransaction service.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  allocateTransaction,
} from '@/modules/accounting/services/bank/bankReconciliationService';
import { isRetryableContention } from '@/modules/accounting/services/core/retryableContention';

const ManualTxSchema = z.object({
  type: z.enum(['spend', 'receive']),
  bankAccountId: UUID,
  date: z.string().min(8).max(30),
  amount: z.union([z.number(), z.string()]).transform(v => Number(v)).refine(n => Number.isFinite(n) && n > 0, {
    message: 'amount must be a positive number',
  }),
  reference: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  allocationType: z.enum(['account', 'supplier', 'customer', 'transfer']),
  contraAccountId: UUID.optional(),
  // entityId is a supplier or customer UUID; service casts to ::UUID downstream.
  entityId: UUID.optional(),
  vatCode: z.string().max(20).optional(),
}).refine(
  v => !(v.allocationType === 'account' && !v.contraAccountId),
  { message: 'contraAccountId is required when allocationType is account', path: ['contraAccountId'] },
).refine(
  v => !((v.allocationType === 'supplier' || v.allocationType === 'customer') && !v.entityId),
  { message: 'entityId is required when allocationType is supplier or customer', path: ['entityId'] },
);

// ── Handler ───────────────────────────────────────────────────────────────────

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req;
  const userId: string = req.user?.id ?? 'system';

  const parsed = ManualTxSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const {
    type, bankAccountId, date, amount: numericAmount,
    reference, description, allocationType, contraAccountId, entityId, vatCode,
  } = parsed.data;

  // ── Amount sign — negative for spend, positive for receive ─────────────────

  const signedAmount = type === 'spend' ? -Math.abs(numericAmount) : Math.abs(numericAmount);

  try {
    // ── Step 1: Insert bank_transactions row ─────────────────────────────────

    const txRows = await sql`
      INSERT INTO bank_transactions (
        bank_account_id,
        transaction_date,
        amount,
        description,
        reference,
        status,
        company_id
      ) VALUES (
        ${bankAccountId}::UUID,
        ${date}::DATE,
        ${signedAmount},
        ${description ?? null},
        ${reference ?? null},
        'imported',
        ${companyId}
      )
      RETURNING id
    `;

    const txId = String((txRows as Record<string, unknown>[])[0]!.id);

    log.info('Manual bank transaction created', {
      txId, type, bankAccountId, amount: signedAmount, date,
    }, 'accounting-api');

    // ── Step 2: Immediately allocate the transaction ──────────────────────────

    const result = await allocateTransaction(
      companyId,
      txId,
      contraAccountId ?? '',
      userId,
      description,
      allocationType,
      entityId,
      vatCode,
    );

    log.info('Manual bank transaction allocated', {
      txId, journalEntryId: result.journalEntryId,
    }, 'accounting-api');

    return apiResponse.created(res, {
      bankTransactionId: txId,
      journalEntryId: result.journalEntryId,
      bankTransaction: result.bankTransaction,
    }, 'Transaction recorded and allocated successfully');
  } catch (err) {
    // Contention is a 409, not a 500. This route calls `allocateTransaction`,
    // so it raises the identical events the four settlement routes answer 409 —
    // and `internalError` replaces the service's "retry in a moment" with "An
    // internal error occurred", which is the one wording the caller can act on.
    // The INSERT above is NOT rolled back by the choice of status — every
    // member of `isRetryableContention` descends from 55P03/40P01, which abort
    // the Postgres transaction, so `withAuth`'s COMMIT on a 4xx is a no-op and
    // the manual row is discarded either way. What changes is the wording the
    // caller reads. A blanket catch on a route that writes BEFORE it can refuse
    // is still a hazard for any non-aborting throw — registered as R-060.
    if (isRetryableContention(err)) {
      log.info('Manual bank transaction hit a contended row', { error: err }, 'accounting-api');
      return apiResponse.conflict(res, (err as Error).message);
    }
    const message = err instanceof Error ? err.message : 'Failed to record transaction';
    log.error('Manual bank transaction failed', { error: err }, 'accounting-api');
    return apiResponse.internalError(res, err, message);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
