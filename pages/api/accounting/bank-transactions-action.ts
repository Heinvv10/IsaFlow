/**
 * Bank Transaction Actions API
 * POST /api/accounting/bank-transactions-action
 *   action: match | unmatch | exclude | auto_match | allocate | delete | update_notes
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { isUuidParam } from '@/lib/validation';
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
import { BankLineChangedError, BankMatchTargetError } from '@/modules/accounting/services/bank/bankTxStatusErrors';
import { refuseLinesInCompletedSession } from '@/modules/accounting/services/bank/reconciliationSessionLock';
import { isRetryableContention } from '@/modules/accounting/services/core/retryableContention';
import {
  BankTransactionNotPostedError, isFeedNotPostedRefusal, readFeedState,
} from '@/modules/accounting/services/bank/bankFeedStateGuard';
import { BankTxActionSchema } from '@/modules/accounting/services/bank/bankTxActionSchema';
import { assertCustomerInCompany, assertSupplierInCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { saveBankTxDimensions, updateBankTxNotes } from '@/modules/accounting/services/bank/bankTxAnnotations';
import { respondIfBankRefusal } from '@/modules/accounting/services/bank/bankRouteRefusal';
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
import { refuseWithoutApprove } from '@/modules/accounting/services/core/approvePermissionResponse';



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
    // #1656 (Hein: gate everything): the actions that post or reverse a journal (allocate, split_allocate, bulk_accept, reverse) ask Banking
    // Approve at the top of their own case, before any write.
    switch (body.action) {
      case 'match': {
        await assertImporterMayMatch(companyId, body.bankTransactionId, body.journalLineId, userId); // step 2: 403 pre-write
        const tx = await matchTransaction(companyId, body.bankTransactionId, body.journalLineId, body.reconciliationId, userId);
        return apiResponse.success(res, tx);
      }
      case 'unmatch': {
        const { expectedStatus } = body;
        const tx = await (expectedStatus
          ? unmatchTransaction(companyId, body.bankTransactionId, userId, { expectedStatus })
          : unmatchTransaction(companyId, body.bankTransactionId, userId));
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
        if (await refuseWithoutApprove(res, companyId, userId, 'banking', 'bank allocations')) return; // #1656 (round 4): the gate sits in the case that posts
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
        if (await refuseWithoutApprove(res, companyId, userId, 'banking', 'bank allocations')) return; // #1656 (round 4): the gate sits in the case that posts
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
        if (await refuseWithoutApprove(res, companyId, userId, 'banking', 'bank allocations')) return; // #1656 (round 4): the gate sits in the case that posts
        await refuseLinesInCompletedSession(companyId, body.bankTransactionIds); // D12: as delete
        const accepted = await bulkAcceptTransactions(companyId, body.bankTransactionIds, userId);
        return apiResponse.success(res, { accepted });
      }
      case 'update_notes': {
        const updated = await updateBankTxNotes(companyId, body.bankTransactionId, body.notes, userId);
        if (!updated) return apiResponse.notFound(res, 'Bank transaction', body.bankTransactionId);
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
        // The same for the account: it is read back with its code and name joined on it, and a foreign or malformed id
        // is a caller error (400, before the UPDATE), not a raw cast failure.
        if (selType === 'account' && selEntityId) {
          const [own] = isUuidParam(selEntityId)
            ? (await sql`SELECT 1 AS ok FROM gl_accounts WHERE id = ${selEntityId}::UUID AND company_id = ${companyId}::UUID`) as Array<{ ok: number }>
            : [];
          if (!own) return apiResponse.badRequest(res, 'Selected account is not one of your accounts');
        }
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
        const saved = await saveBankTxDimensions(companyId, body.bankTransactionId,
          { cc1Id: body.cc1Id ?? undefined, cc2Id: body.cc2Id ?? undefined, buId: body.buId ?? undefined }, userId);
        if (!saved) return apiResponse.notFound(res, 'Bank transaction', body.bankTransactionId);
        return apiResponse.success(res, { saved: true });
      }
      case 'reverse': {
        if (await refuseWithoutApprove(res, companyId, userId, 'banking', 'bank allocations')) return; // #1656 (round 4): the gate sits in the case that posts
        const { expectedJournalEntryId } = body;
        // census-exempt(reverseReconciledTransaction): a ledger or return action: the payroll tables its chain reads feed a refusal or the month's ETI carry; the answer names no employee and no one person's pay
        const reversed = await withJournalDateRefusal(res, () => (expectedJournalEntryId
          ? reverseReconciledTransaction(companyId, body.bankTransactionId, userId, { expectedJournalEntryId })
          : reverseReconciledTransaction(companyId, body.bankTransactionId, userId)));
        if (reversed === JOURNAL_DATE_REFUSED) return;
        return apiResponse.success(res, { reversed: true, vatLockRoll: reversed?.vatLockRoll, originalEntryDate: reversed?.originalEntryDate, reversalEntryDate: reversed?.reversalEntryDate });
      }
    }
  } catch (err) {
    // A held bank line, payment, bill or invoice is a lock timeout on EVERY verb: 503 + Retry-After (D8 round 17 for
    // reverse, D11 for the rest). Only a retryable STATE conflict keeps K-071's 409 below.
    if (respondIfLockTimeout(res, err)) return;
    if (err instanceof BankLineChangedError) return apiResponse.conflict(res, err.message); // a stale Undo: nothing written
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
    // Audit WP2 row 9: the typed refusals keep their 4xx; anything else is a fault — rethrown, withErrorHandler's 500
    // rolls the request back. (A 400 here COMMITTED whatever a crash had already written: a delete, an exclude.)
    if (respondIfBankRefusal(res, err)) return;
    log.error('Bank transaction action failed', { action: body.action, error: err }, 'accounting-api');
    throw err;
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
