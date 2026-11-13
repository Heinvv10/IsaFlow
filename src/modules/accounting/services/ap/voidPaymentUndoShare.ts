/**
 * Void a contra supplier payment AND undo the share a person had taken out of its clearing account for each bill it
 * settled — `void_payment(undo_share: true, share_journal_id)` (step 6, 2026-11-13). What the share is and every
 * refusal: `shareUndoPlan.ts`. Today a person does this in two steps every time (Velocity JE-2026-29151/29152/29163/
 * 29193, JE-2026-31951).
 *
 * ORDER. The plan runs INSIDE the void (`beforeFirstWrite`): after the void has taken its locks in the canonical
 * order (bank line, then payment — core/paymentVoidService) and passed its own refusals, before its first write. So
 * the allocations the plan splits are the ones the void unwinds, and every refusal of the undo still writes nothing.
 * The void then runs unchanged — every existing guard, the credit ceiling (ap/supplierVoidCredit) included — and the
 * undo journals post AFTER it, in the same savepoint. No catch: a throw anywhere unwinds both.
 *
 * R-035: the undo journals are agent-composed manual journals posted in the same call, so the call is refused up front
 * (`agentNewManualJournalsRefusal`, from the plan, before the void writes) when an enforced manual-journal rule matches
 * any of them, as `post_reclassification_batch` is. Named limit: this gate is the AGENT's; a human caller of this
 * service would need `newManualJournalRefusal` instead (none exists today). The gate is applied per journal AND to the
 * call's lines as one, so splitting an undo over several bills cannot step under a rule.
 *
 * NUMBER LOCKS (arch review #7). The void's reversal is numbered in the contra's year and each undo in the share's
 * year, each under its company+year number lock (migration 858), taken as each journal is created. When those years
 * differ, two such calls taking the two years in opposite orders can deadlock; Postgres aborts one (40P01), the
 * savepoint unwinds everything it wrote, and the registry answers it retryable (`lockWaitError.deadlockErrorText`:
 * "nothing was written; retry"). Accepted rather than pre-locking both years: the window needs two undo calls across
 * the same two years at the same instant, and the outcome is a clean retry.
 */
import type { PostingActorOpts } from '../gl/journalEntryMeta';
import { agentNewManualJournalsRefusal } from '../gl/manualJournalApproval';
import {
  isVoidRefusal, voidPaymentDocument, type VoidPaymentResult, type VoidRefusal,
} from '../core/paymentVoidService';
import { toCents } from './billAllocatable';
import { planShareUndo } from './shareUndoPlan';
import { ShareUndoRefusal, type ShareUndoChoices, type ShareUndoPlan } from './shareUndoTypes';
import { postShareUndoJournals, type PostedShareUndo } from './shareUndoPost';

export interface VoidWithShareUndoResult extends VoidPaymentResult {
  undoShare: { plan: ShareUndoPlan; posted: PostedShareUndo[] };
}

export async function voidPaymentUndoingShare(
  companyId: string,
  paymentId: string,
  shareJournalId: string,
  userId: string,
  opts?: PostingActorOpts & { reversalDate?: string },
  choices: ShareUndoChoices = {},
): Promise<VoidWithShareUndoResult | VoidRefusal> {
  // A holder, not a `let`: the hook assigns it, which control-flow narrowing cannot see.
  const held: { plan?: ShareUndoPlan } = {};
  const voided = await voidPaymentDocument(companyId, 'supplier', paymentId, userId, {
    ...opts,
    beforeFirstWrite: async (payment) => {
      const plan = await planShareUndo(companyId, payment, shareJournalId, choices);
      // Per journal AND for the call as a whole (security review): a rule over R10,000 must not be dodged by an undo
      // that posts six R2,000 journals in one call.
      const lines = plan.journals.map((j) => j.lines);
      const refusal = await agentNewManualJournalsRefusal(companyId, [...lines, lines.flat()]);
      if (refusal) throw new ShareUndoRefusal(refusal);
      held.plan = plan;
    },
  });
  if (isVoidRefusal(voided)) return voided;
  const plan = held.plan;
  // The hook runs on every path that reaches a write; a void that returned without it is a broken invariant.
  if (!plan) throw new Error(`void_payment undo_share: payment ${paymentId} was voided without its undo plan`);
  // Belt and braces: the plan read the allocations under the void's payment lock, so the unwind must report them.
  if (voided.invoicesReopened !== plan.allocationRows || toCents(voided.amountUnapplied) !== toCents(plan.allocatedTotal)) {
    throw new ShareUndoRefusal('The payment\'s allocations changed while it was being voided — nothing was written; '
      + 'retry in a moment.', { retryable: true });
  }
  const posted = await postShareUndoJournals(companyId, userId, plan, opts);
  return { ...voided, undoShare: { plan, posted } };
}
