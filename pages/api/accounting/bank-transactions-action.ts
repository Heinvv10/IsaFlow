/**
 * Bank Transaction Actions API
 * POST /api/accounting/bank-transactions-action
 *   action: match | unmatch | exclude | auto_match | allocate | delete | update_notes
 */

import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { isRetryableContention } from '@/modules/accounting/services/core/retryableContention';
import { UUID } from '@/lib/schemas/common';
import {
  matchTransaction,
  unmatchTransaction,
  excludeTransaction,
  autoMatchTransactions,
  allocateTransaction,
  splitAllocateTransaction,
  deleteTransactions,
  bulkAcceptTransactions,
  reverseReconciledTransaction,
  type AllocationType,
  type SplitLine,
} from '@/modules/accounting/services/bank/bankReconciliationService';

const BankTxActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('match'), bankTransactionId: UUID, journalLineId: UUID, reconciliationId: UUID.optional() }),
  z.object({ action: z.literal('unmatch'), bankTransactionId: UUID }),
  z.object({ action: z.literal('exclude'), bankTransactionId: UUID, excludeReason: z.string().max(200).optional() }),
  z.object({ action: z.literal('auto_match'), bankAccountId: UUID, reconciliationId: UUID.optional() }),
  z.object({
    action: z.literal('allocate'),
    bankTransactionId: UUID,
    allocationType: z.enum(['account', 'supplier', 'customer', 'transfer']).optional(),
    contraAccountId: UUID.optional(),
    entityId: UUID.optional(),
    description: z.string().max(500).optional(),
    vatCode: z.string().max(20).optional(),
    cc1Id: UUID.optional(),
    cc2Id: UUID.optional(),
    buId: UUID.optional(),
  }),
  z.object({
    action: z.literal('split_allocate'),
    bankTransactionId: UUID,
    lines: z.array(z.object({ contraAccountId: UUID.optional(), amount: z.number(), description: z.string().max(500).optional() })).min(1),
  }),
  z.object({ action: z.literal('delete'), bankTransactionId: UUID.optional(), bankTransactionIds: z.array(UUID).optional() }),
  z.object({ action: z.literal('bulk_accept'), bankTransactionIds: z.array(UUID).min(1) }),
  z.object({ action: z.literal('update_notes'), bankTransactionId: UUID, notes: z.string().max(1000).optional() }),
  z.object({
    action: z.literal('save_selection'),
    bankTransactionId: UUID,
    selectionType: z.string().max(50).optional(),
    selectionEntityId: UUID.optional(),
    vatCode: z.string().max(20).optional(),
  }),
  z.object({
    action: z.literal('save_dimensions'),
    bankTransactionId: UUID,
    cc1Id: UUID.optional(),
    cc2Id: UUID.optional(),
    buId: UUID.optional(),
  }),
  z.object({ action: z.literal('reverse'), bankTransactionId: UUID }),
]);

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const parsed = BankTxActionSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }

  const { companyId } = req;

  const body = parsed.data;
  try {
    const userId: string = req.user?.id || 'system';

    switch (body.action) {
      case 'match': {
        const tx = await matchTransaction(companyId, body.bankTransactionId, body.journalLineId, body.reconciliationId);
        return apiResponse.success(res, tx);
      }
      case 'unmatch': {
        const tx = await unmatchTransaction(companyId, body.bankTransactionId);
        return apiResponse.success(res, tx);
      }
      case 'exclude': {
        const tx = await excludeTransaction(companyId, body.bankTransactionId, body.excludeReason);
        return apiResponse.success(res, tx);
      }
      case 'auto_match': {
        const result = await autoMatchTransactions(companyId, body.bankAccountId, body.reconciliationId);
        return apiResponse.success(res, result);
      }
      case 'allocate': {
        const aType: AllocationType = body.allocationType || 'account';
        if (aType === 'account' && !body.contraAccountId) {
          return apiResponse.badRequest(res, 'contraAccountId is required for account allocation');
        }
        if ((aType === 'supplier' || aType === 'customer') && !body.entityId) {
          return apiResponse.badRequest(res, 'entityId is required for supplier/customer allocation');
        }
        if (aType === 'transfer' && !body.contraAccountId) {
          return apiResponse.badRequest(res, 'contraAccountId is required for transfer allocation (the counterparty bank account)');
        }
        const result = await allocateTransaction(
          companyId, body.bankTransactionId, body.contraAccountId || null, userId,
          body.description, aType, body.entityId, body.vatCode,
          body.cc1Id, body.cc2Id, body.buId,
        );
        return apiResponse.success(res, result);
      }
      case 'split_allocate': {
        const splitLines = body.lines as SplitLine[];
        const splitResult = await splitAllocateTransaction(companyId, body.bankTransactionId, splitLines, userId);
        return apiResponse.success(res, splitResult);
      }
      case 'delete': {
        const ids: string[] = body.bankTransactionIds || (body.bankTransactionId ? [body.bankTransactionId] : []);
        if (ids.length === 0) return apiResponse.badRequest(res, 'bankTransactionId or bankTransactionIds required');
        const deleted = await deleteTransactions(companyId, ids);
        return apiResponse.success(res, { deleted });
      }
      case 'bulk_accept': {
        const accepted = await bulkAcceptTransactions(companyId, body.bankTransactionIds);
        return apiResponse.success(res, { accepted });
      }
      case 'update_notes': {
        await sql`
          UPDATE bank_transactions
          SET notes = ${body.notes || null}, updated_at = NOW()
          WHERE id = ${body.bankTransactionId}::UUID AND company_id = ${companyId}
        `;
        log.info('Updated bank transaction notes', { bankTransactionId: body.bankTransactionId }, 'accounting-api');
        return apiResponse.success(res, { updated: true });
      }
      case 'save_selection': {
        const selType: string = body.selectionType || 'account';
        const selEntityId: string | null = body.selectionEntityId || null;
        const selVatCode: string | null = body.vatCode || null;
        await sql`
          UPDATE bank_transactions
          SET suggested_gl_account_id = ${selType === 'account' && selEntityId ? selEntityId : null}::UUID,
              suggested_supplier_id = ${selType === 'supplier' && selEntityId ? selEntityId : null}::UUID,
              suggested_client_id = ${selType === 'customer' && selEntityId ? selEntityId : null}::UUID,
              suggested_vat_code = ${selVatCode},
              updated_at = NOW()
          WHERE id = ${body.bankTransactionId}::UUID AND status IN ('imported', 'allocated') AND company_id = ${companyId}
        `;
        return apiResponse.success(res, { saved: true });
      }
      case 'save_dimensions': {
        await sql`
          UPDATE bank_transactions
          SET cc1_id = ${body.cc1Id || null}::UUID,
              cc2_id = ${body.cc2Id || null}::UUID,
              bu_id = ${body.buId || null}::UUID,
              updated_at = NOW()
          WHERE id = ${body.bankTransactionId}::UUID AND company_id = ${companyId}
        `;
        return apiResponse.success(res, { saved: true });
      }
      case 'reverse': {
        await reverseReconciledTransaction(companyId, body.bankTransactionId, userId);
        return apiResponse.success(res, { reversed: true });
      }
    }
  } catch (err) {
    // CONTENTION first, and 409 — the status this codebase gives "a peer holds
    // the row, retry". `allocate` reaches `planSupplierPaymentApplication` and
    // `planReceiptApplication` through `recordSupplierBankPayment` /
    // `autoApplyCustomerReceipt`, so this route raises the SAME event that
    // `bank-match-confirm` answers 409 — and answered it 400 until this branch.
    // Every member is pre-write, so the 4xx `withAuth` COMMITs commits nothing.
    if (isRetryableContention(err)) {
      log.info('Bank transaction action hit a contended row', { action: body.action }, 'accounting-api');
      return apiResponse.conflict(res, (err as Error).message);
    }
    const message = err instanceof Error ? err.message : 'Action failed';
    log.error('Bank transaction action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
