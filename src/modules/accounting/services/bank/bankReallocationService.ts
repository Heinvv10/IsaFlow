/**
 * Re-point a RECONCILED statement line — one in a COMPLETED bank reconciliation — to a different allocation target
 * WITHOUT reopening the reconciliation (MCP `reallocate_bank_transaction`). The bank side does not change.
 *
 * The old allocation journal is reversed and a new allocation journal posted, BOTH dated on the original entry date,
 * and the line is re-linked to the new journal's bank leg, which carries the same account and amount. So the bank GL
 * balance as at every date is unchanged, the line still has exactly one live bank leg, and the reconciliation row —
 * its figures frozen at completion — is untouched. Anything that cannot keep that date or shape is refused before
 * any write (bankReallocationGuards); the date is never rolled.
 *
 * ORDER IS LOAD-BEARING. Old documents unwound (payment -> bills/invoices, before the journal, as every reversal
 * does) -> old journal head locked -> NEW journal posted and the line re-linked to it (allocateTransaction under
 * `reallocation`, which accepts this line's own completed reconciliation and nothing else) -> old journal reversed.
 * With the line re-linked first, the reversal's D12 re-check (refuseReversingCompletedCash) finds no reconciled
 * cash on the old journal and passes — no exemption exists or is added. Then the line goes back to 'reconciled' with
 * its original review stamp, and the bank leg is asserted unchanged. Every write is in one savepoint.
 *
 * Lock order (reconciliationSessionLock.ts): the chain's lines in id order -> the line's session FOR SHARE -> the
 * line -> the documents (unwind) -> the old journal head -> the VAT shared key / numbering lock of the posts; all
 * under one flow lock budget.
 */
import { withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import type { PostingActorOpts } from '../gl/journalEntryMeta';
import type { DimensionIds } from '../gl/dimensions/dimensionTypes';
import type { AutoApplyMode } from '../shared/autoAllocateStrategy';
import { reverseJournalEntry } from '../gl/journalEntryPostingService';
import { logAuditOrThrow } from '../core/auditTrailService';
import { underFlowLockBudget } from '../core/rowLockBudget';
import { allocateTransaction } from './bankAllocationService';
import type { AllocationApplicationResult } from './bankAllocationTypes';
import { unwindBankAllocationApplication, type BankAllocationUnwindResult } from './bankAllocationUnwind';
import { BankAllocationRefusal } from './bankAllocationRefusal';
import { lockChainLines, peekLineChain, refuseStaleUndo } from './bankChainLineReversal';
import { lockBankTransactionForUpdate } from './bankTxLock';
import { agentReversalRefusal, assertMayReverse, auditedReversal } from './bankReversalGate';
import { lockPeekedReversalTarget } from './reversalDatePostable';
import {
  BankReallocationRefusal, loadReallocationFacts, planReallocation, type ReallocationTarget,
} from './bankReallocationGuards';
import {
  assertBankLegKept, assertOriginalDateKept, newDocumentOf, readBankLeg, restoreReconciled, type NewDocumentKind,
} from './bankReallocationWrites';

export type ReallocationOpts = PostingActorOpts & {
  /** The journal the caller read the line on: anything else is a stale read, refused. */
  expectedJournalEntryId: string;
  autoApply: AutoApplyMode;
  /** The VAT code to post with (already coerced by the caller's VAT guard, as allocate's is). */
  vatType?: string;
  dims?: DimensionIds;
};

export interface ReallocationResult {
  outcome: 'reallocated' | 'nothing_changed';
  transactionId: string;
  reconciliationId: string;
  originalJournalEntryId: string;
  reversalJournalEntryId: string | null;
  newJournalEntryId: string | null;
  entryDate: string;
  bankLeg: { accountId: string; amount: number; oldLineId: string; newLineId: string | null };
  unwound: BankAllocationUnwindResult;
  newDocument: { kind: NewDocumentKind; paymentId: string | null };
  application?: AllocationApplicationResult;
}

const NOTHING_UNWOUND: BankAllocationUnwindResult = { invoicesReopened: 0, amountUnapplied: 0, paymentsCancelled: 0 };

export async function reallocateReconciledTransaction(
  companyId: string, bankTxId: string, userId: string, target: ReallocationTarget, opts: ReallocationOpts,
): Promise<ReallocationResult> {
  return underFlowLockBudget(`Bank transaction ${bankTxId}`, () => reallocateInner(companyId, bankTxId, userId, target, opts));
}

async function reallocateInner(
  companyId: string, bankTxId: string, userId: string, target: ReallocationTarget, opts: ReallocationOpts,
): Promise<ReallocationResult> {
  const chain = await peekLineChain(companyId, bankTxId);
  if (chain) await lockChainLines(companyId, chain);
  const tx = await lockBankTransactionForUpdate(companyId, bankTxId);
  if (!tx) throw new BankReallocationRefusal('Not found');
  if (String(tx.matched_journal_line_id ?? '') !== (chain?.lineId ?? '')) {
    throw new BankAllocationRefusal('This bank line was changed by another request while it was being reallocated — '
      + 'retry in a moment.', undefined, { retryable: true });
  }
  const plan = planReallocation(await loadReallocationFacts(companyId, tx, chain, target), target, opts);
  const amount = Math.round((plan.bankLeg.debit - plan.bankLeg.credit) * 100) / 100;
  const base = {
    transactionId: bankTxId, reconciliationId: plan.reconciliationId, originalJournalEntryId: plan.journalId,
    entryDate: plan.entryDate,
  };
  if (plan.kind === 'nothing_changed') {
    return {
      ...base, outcome: 'nothing_changed', reversalJournalEntryId: null, newJournalEntryId: null,
      bankLeg: { accountId: plan.bankLeg.glAccountId, amount, oldLineId: plan.bankLeg.lineId, newLineId: null },
      unwound: NOTHING_UNWOUND, newDocument: { kind: 'none', paymentId: null },
    };
  }
  // The reversal half is a reversal: an agent under enforcement may not make it, nor its allocator (step 2).
  const agentRefusal = await agentReversalRefusal(companyId, [bankTxId]);
  if (agentRefusal) throw agentRefusal;
  const clearance = await assertMayReverse(companyId, tx, chain!.rootId, userId);
  await assertOriginalDateKept(companyId, plan.journalId, plan.entryDate);
  const reviewed = { at: tx.reviewed_at, by: tx.reviewed_by };
  const actor: PostingActorOpts = {
    ...(opts.postingAgent === undefined ? {} : { postingAgent: opts.postingAgent }),
    ...(opts.actorType === undefined ? {} : { actorType: opts.actorType }),
    ...(opts.actorTokenJti === undefined ? {} : { actorTokenJti: opts.actorTokenJti }),
  };

  const done = await withSavepoint('bank_reallocate', async () => {
    const unwound = await unwindBankAllocationApplication(companyId, plan.journalId);
    await lockPeekedReversalTarget(companyId, plan.journalId, plan.journalId); // the old journal locked last
    await refuseStaleUndo(companyId, bankTxId, chain, opts.expectedJournalEntryId);
    const posted = await allocateTransaction(
      companyId, bankTxId, target.kind === 'account' ? target.glAccountId : null, userId, undefined, target.kind,
      target.kind === 'supplier' ? target.supplierId : target.kind === 'customer' ? target.customerId : undefined,
      opts.vatType, opts.dims?.cc1Id, opts.dims?.cc2Id, opts.dims?.buId, undefined,
      { ...actor, autoApply: opts.autoApply, reallocation: { reconciliationId: plan.reconciliationId } },
    );
    // The line is on the new journal now, so the old one carries no reconciled cash: its reversal is a plain one.
    const reversal = await reverseJournalEntry(companyId, plan.journalId, userId, { ...actor, reversalDate: plan.entryDate });
    if (fmtDate(reversal.entryDate) !== plan.entryDate) {
      throw new BankReallocationRefusal('The reversal could not keep the original date; nothing was written.');
    }
    const leg = assertBankLegKept(plan.bankLeg, plan.entryDate, await readBankLeg(companyId, bankTxId), posted.journalEntryId);
    await restoreReconciled(companyId, bankTxId, plan.reconciliationId, leg.lineId, reviewed);
    return { unwound, posted, reversalId: reversal.id, newLineId: leg.lineId };
  });

  await auditedReversal(companyId, bankTxId, userId, clearance, null);
  await logAuditOrThrow({
    companyId, userId, action: 'update', entityType: 'bank_transaction', entityId: bankTxId,
    changes: {
      fields: [{ field: 'matched_journal_line_id', old: plan.bankLeg.lineId, new: done.newLineId, label: 'Allocation journal line' }],
      metadata: {
        operation: 'reallocate', reconciliationId: plan.reconciliationId, originalJournalEntryId: plan.journalId,
        reversalJournalEntryId: done.reversalId, newJournalEntryId: done.posted.journalEntryId, targetKind: target.kind,
        targetId: target.kind === 'account' ? target.glAccountId : target.kind === 'supplier' ? target.supplierId : target.customerId,
        entryDate: plan.entryDate, postingAgent: opts.postingAgent ?? '',
      },
    },
  });
  log.info('Reallocated reconciled bank transaction', {
    companyId, bankTxId, reconciliationId: plan.reconciliationId, originalJournalEntryId: plan.journalId,
    newJournalEntryId: done.posted.journalEntryId, reversalJournalEntryId: done.reversalId,
  }, 'accounting');
  return {
    ...base, outcome: 'reallocated', reversalJournalEntryId: done.reversalId, newJournalEntryId: done.posted.journalEntryId,
    bankLeg: { accountId: plan.bankLeg.glAccountId, amount, oldLineId: plan.bankLeg.lineId, newLineId: done.newLineId },
    unwound: done.unwound,
    newDocument: await newDocumentOf(companyId, done.posted.journalEntryId, target, amount < 0),
    ...(done.posted.application ? { application: done.posted.application } : {}),
  };
}
