/**
 * Bank Transaction Actions API
 * POST /api/accounting/bank-transactions-action
 *   action: match | unmatch | exclude | auto_match | allocate | delete | update_notes
 */

import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { JOURNAL_DATE_REFUSED, withJournalDateRefusal } from '@/lib/apiJournalDate';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { respondIfApprovalRequired } from '@/modules/accounting/services/gl/approvalGateResponse';
import { respondIfBankControlRefused } from '@/modules/accounting/services/bank/bankControlResponse';
import { assertImporterMayMatch } from '@/modules/accounting/services/bank/bankLineImporterGate';
import { respondIfReconciliationCompleted } from '@/lib/apiReconciliationCompleted';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { BankMatchTargetError } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import { refuseLinesInCompletedSession } from '@/modules/accounting/services/bank/reconciliationSessionLock';
import { isRetryableContention } from '@/modules/accounting/services/core/retryableContention';
import {
  BankTransactionNotPostedError, isFeedNotPostedRefusal, readFeedState,
} from '@/modules/accounting/services/bank/bankFeedStateGuard';
import { UUID } from '@/lib/schemas/common';
import { AUTO_APPLY_MODES } from '@/modules/accounting/services/shared/autoAllocateStrategy';
import { assertCustomerInCompany, assertSupplierInCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { assertJournalAnalysisDimensions } from '@/modules/accounting/services/gl/journalCostCentreValidation';
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
    // What to do with a supplier/customer line that names no document.
    // 'fifo' (the default) settles that contact's oldest open documents.
    autoApply: z.enum(AUTO_APPLY_MODES).optional(),
  }),
  z.object({
    action: z.literal('split_allocate'),
    bankTransactionId: UUID,
    lines: z.array(z.object({
      // Positive rand-and-cents: the split posts each line in the bank line's own direction.
      contraAccountId: UUID.optional(), amount: z.number().positive().refine((n) => Number(n.toFixed(2)) === n, 'amount must be in whole cents'),
      description: z.string().max(500).optional(),
      // The line's VAT treatment, as the split modal sends it (VAT_OPTIONS). Missing from this schema from BL-33
      // (2026-04-15) until 2026-10-14: zod stripped it, and every screen split posted with no VAT leg.
      vatCode: z.enum(['none', 'standard', 'zero_rated', 'exempt']).optional(),
      // Per-line dimensions, stamped on that line's cost/revenue leg only (bankSplitDimensions.ts).
      cc1Id: UUID.optional(), cc2Id: UUID.optional(), buId: UUID.optional(),
      // A line that settles a supplier/customer instead of a GL account (bankSplitContacts.ts).
      contactType: z.enum(['supplier', 'customer']).optional(), contactId: UUID.optional(),
      autoApply: z.enum(AUTO_APPLY_MODES).optional(),
    }).superRefine((line, ctx) => {
      // Exactly one target, as the MCP tool requires: a line naming both would silently drop the account.
      const contact = line.contactType !== undefined || line.contactId !== undefined;
      if (contact && (line.contactType === undefined || line.contactId === undefined)) {
        ctx.addIssue({ code: 'custom', message: 'contactType and contactId go together' });
      } else if (contact === (line.contraAccountId !== undefined)) {
        ctx.addIssue({ code: 'custom', message: 'a split line names exactly one of contraAccountId or contactType + contactId' });
      } else if (!contact && line.autoApply !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'autoApply applies only to a supplier/customer line' });
      } else if (contact && (line.cc1Id || line.cc2Id || line.buId)) {
        ctx.addIssue({ code: 'custom', message: 'a supplier/customer line carries no cc1/cc2/bu' });
      } else if (contact && line.vatCode !== undefined && line.vatCode !== 'none') {
        ctx.addIssue({ code: 'custom', message: 'a supplier/customer line carries no VAT (the bill or invoice already did)' });
      }
    })).min(1),
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
        await assertImporterMayMatch(companyId, body.bankTransactionId, body.journalLineId, userId); // step 2: 403 pre-write
        const tx = await matchTransaction(companyId, body.bankTransactionId, body.journalLineId, body.reconciliationId, userId);
        return apiResponse.success(res, tx);
      }
      case 'unmatch': {
        const tx = await unmatchTransaction(companyId, body.bankTransactionId, userId);
        return apiResponse.success(res, tx);
      }
      case 'exclude': {
        const tx = await excludeTransaction(companyId, body.bankTransactionId, body.excludeReason, userId);
        return apiResponse.success(res, tx);
      }
      case 'auto_match': {
        const result = await autoMatchTransactions(companyId, body.bankAccountId, body.reconciliationId, userId);
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
        const result = await withJournalDateRefusal(res, () => allocateTransaction(
          companyId, body.bankTransactionId, body.contraAccountId || null, userId,
          body.description, aType, body.entityId, body.vatCode,
          body.cc1Id, body.cc2Id, body.buId,
          undefined,
          // autoApply omitted rather than defaulted here: the service owns the
          // default, and a second copy of it is how two entry points drift apart.
          // A person allocating: s16(3) late input-VAT claim where allowed.
          { ...(body.autoApply ? { autoApply: body.autoApply } : {}), allowLateInputClaim: true },
        ));
        if (result === JOURNAL_DATE_REFUSED) return;
        return apiResponse.success(res, result);
      }
      case 'split_allocate': {
        const splitLines = body.lines as SplitLine[];
        const splitResult = await withJournalDateRefusal(res, () => splitAllocateTransaction(
          companyId, body.bankTransactionId, splitLines, userId, { allowLateInputClaim: true }));
        if (splitResult === JOURNAL_DATE_REFUSED) return;
        return apiResponse.success(res, splitResult);
      }
      case 'delete': {
        const ids: string[] = body.bankTransactionIds || (body.bankTransactionId ? [body.bankTransactionId] : []);
        if (ids.length === 0) return apiResponse.badRequest(res, 'bankTransactionId or bankTransactionIds required');
        await refuseLinesInCompletedSession(companyId, ids); // D12: any line in a completed session refuses it all, 409
        const deleted = await deleteTransactions(companyId, ids);
        return apiResponse.success(res, { deleted });
      }
      case 'bulk_accept': {
        await refuseLinesInCompletedSession(companyId, body.bankTransactionIds); // D12: as delete
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
        // R-067: suggested_client_id is read back with the customer name joined
        // on it. Refused before the UPDATE; the catch below answers 400.
        if (selType === 'customer') await assertCustomerInCompany(companyId, selEntityId);
        if (selType === 'supplier') await assertSupplierInCompany(companyId, selEntityId); // R-068
        // Refused from a read, before the write: the UPDATE's feed_state
        // predicate alone would answer { saved: true } for a no-op (F-M2).
        const feedState = await readFeedState(companyId, body.bankTransactionId);
        if (feedState && feedState !== 'posted') {
          return apiResponse.conflict(res, new BankTransactionNotPostedError(body.bankTransactionId, feedState, 'categorise').message);
        }
        await sql`
          UPDATE bank_transactions
          SET suggested_gl_account_id = ${selType === 'account' && selEntityId ? selEntityId : null}::UUID,
              suggested_supplier_id = ${selType === 'supplier' && selEntityId ? selEntityId : null}::UUID,
              suggested_client_id = ${selType === 'customer' && selEntityId ? selEntityId : null}::UUID,
              suggested_vat_code = ${selVatCode},
              updated_at = NOW()
          WHERE id = ${body.bankTransactionId}::UUID AND status IN ('imported', 'allocated')
            AND feed_state = 'posted' AND company_id = ${companyId}
        `;
        return apiResponse.success(res, { saved: true });
      }
      case 'save_dimensions': {
        await assertJournalAnalysisDimensions(companyId, [{
          cc1Id: body.cc1Id,
          cc2Id: body.cc2Id,
          buId: body.buId,
        }]);
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
        if (await withJournalDateRefusal(res, () => reverseReconciledTransaction(companyId, body.bankTransactionId, userId)) === JOURNAL_DATE_REFUSED) return;
        return apiResponse.success(res, { reversed: true });
      }
    }
  } catch (err) {
    // A held bank line, payment, bill or invoice is a lock timeout on EVERY verb: 503 + Retry-After (D8 round 17 for
    // reverse, D11 for the rest). Only a retryable STATE conflict keeps K-071's 409 below.
    if (respondIfLockTimeout(res, err)) return;
    // D12: a line in (or a run into) a COMPLETED reconciliation — 409, refused before any write, on every verb.
    if (respondIfReconciliationCompleted(res, err)) return;
    // R-035 PR5 (D2): a hand-keyed line paying a supplier past an enforced rule — refused before any write.
    if (respondIfApprovalRequired(res, err)) return;
    // Step 2: the importer allocating their own statement's line, or the allocator reversing their own allocation — pre-write, 403.
    if (respondIfBankControlRefused(res, err)) return;
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
    // A pending/removed feed row, one status whichever shape it arrives in:
    // match/unmatch/exclude throw the bare BankTransactionNotPostedError;
    // allocate/split throw a BankAllocationRefusal carrying the feed state.
    // Every throw site decides this before its first write.
    if (isFeedNotPostedRefusal(err)) {
      return apiResponse.conflict(res, err.message);
    }
    // auto_match's loop skips every per-candidate refusal inside its own savepoint; what reaches here is a RUN-level
    // failure. A session that no longer exists is 404 (the run's savepoint already discarded its matches); anything else is
    // a fault: 500 through withErrorHandler (rollback), never a 400 that COMMITs what the loop applied (D11 round 7).
    if (body.action === 'auto_match') {
      if (err instanceof BankMatchTargetError && err.code === 'RECONCILIATION_NOT_FOUND') {
        return apiResponse.notFound(res, 'Reconciliation', body.reconciliationId);
      }
      throw err;
    }
    const message = err instanceof Error ? err.message : 'Action failed';
    log.error('Bank transaction action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
