/**
 * Manual Bank Transaction API — Spend Money / Receive Money
 * POST /api/accounting/bank-transactions-manual
 * Equivalent to Sage "Create Transaction" in Process Bank.
 *
 * Inserts a bank_transaction record and immediately allocates it
 * via the existing allocateTransaction service.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  allocateTransaction,
  type AllocationType,
} from '@/modules/accounting/services/bankReconciliationService';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ManualTxBody {
  type: 'spend' | 'receive';
  bankAccountId: string;
  date: string;
  amount: number | string;
  reference?: string;
  description?: string;
  allocationType: AllocationType;
  /** GL account ID (when allocationType === 'account') */
  contraAccountId?: string;
  /** Supplier or Customer ID (when allocationType is supplier/customer) */
  entityId?: string;
  vatCode?: string;
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  // @ts-expect-error — auth middleware attaches user
  const userId: string = req.user?.id ?? req.user?.userId ?? 'system';

  const body = req.body as ManualTxBody;
  const {
    type,
    bankAccountId,
    date,
    amount: rawAmount,
    reference,
    description,
    allocationType,
    contraAccountId,
    entityId,
    vatCode,
  } = body;

  // ── Validation ─────────────────────────────────────────────────────────────

  if (!type || (type !== 'spend' && type !== 'receive')) {
    return apiResponse.badRequest(res, "type must be 'spend' or 'receive'");
  }
  if (!bankAccountId) {
    return apiResponse.badRequest(res, 'bankAccountId is required');
  }
  if (!date) {
    return apiResponse.badRequest(res, 'date is required');
  }
  const numericAmount = Number(rawAmount);
  if (!rawAmount || isNaN(numericAmount) || numericAmount <= 0) {
    return apiResponse.badRequest(res, 'amount must be a positive number');
  }
  if (!allocationType) {
    return apiResponse.badRequest(res, 'allocationType is required');
  }
  if (allocationType === 'account' && !contraAccountId) {
    return apiResponse.badRequest(res, 'contraAccountId is required when allocationType is account');
  }
  if ((allocationType === 'supplier' || allocationType === 'customer') && !entityId) {
    return apiResponse.badRequest(res, 'entityId is required when allocationType is supplier or customer');
  }

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const txId = String((txRows as any[])[0]!.id);

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
    const message = err instanceof Error ? err.message : 'Failed to record transaction';
    log.error('Manual bank transaction failed', { error: err }, 'accounting-api');
    return apiResponse.internalError(res, err, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
