/**
 * Post the undo-share journals `shareUndoPlan.ts` planned (void_payment undo_share, step 6). Everything here WRITES,
 * after the void, in the same savepoint as the void: nothing catches, so a closed period, a VAT lock that landed since
 * the plan, an inactive account or an approval rule the 869 backstop applies unwinds the void with it.
 *
 * R-035 (manual journals): composed by an agent and posted in the same call, like `post_reclassification_batch`. The
 * caller refused the call up front when an enforced rule matches any journal (`agentNewManualJournalsRefusal`); under
 * enforcement each journal is still marked, so migration 869's backstop judges it as it posts.
 */
import { log } from '@/lib/logger';
import { createJournalEntry } from '../gl/journalEntryCrudService';
import { postJournalEntry } from '../gl/journalEntryPostingService';
import { actorMeta, type PostingActorOpts } from '../gl/journalEntryMeta';
import { isEnforced } from '../gl/approvalEnforcement';
import { markManualJournal } from '../gl/manualJournalApproval';
import type { ShareUndoPlan } from './shareUndoPlan';

export interface PostedShareUndo {
  billId: string;
  billNumber: string;
  amount: number;
  reference: string;
  journalEntryId: string;
  entryNumber: string | null;
}

export async function postShareUndoJournals(
  companyId: string, userId: string, plan: ShareUndoPlan, actor?: PostingActorOpts,
): Promise<PostedShareUndo[]> {
  const enforced = await isEnforced(companyId, 'manual_journal');
  const posted: PostedShareUndo[] = [];
  for (const j of plan.journals) {
    // Sequential: one request client, one savepoint stack.
    const entry = await createJournalEntry(
      companyId,
      { entryDate: plan.shareJournal.entryDate, description: j.description, source: 'manual', reference: j.reference,
        lines: j.lines },
      userId,
      // Stamped as the agent, or it lands as the token owner's own typing and drops out of list_agent_postings.
      actorMeta(actor),
      // The legs mirror the bill's POSTED lines, dimensions included: copied, never re-derived.
      { dimensionAssignmentMode: 'historical-copy' },
    );
    if (!entry.fiscalPeriodId) {
      throw new Error(`No fiscal period covers ${plan.shareJournal.entryDate} — the undo journal would be invisible `
        + 'to the trial balance and the VAT201.');
    }
    if (enforced) await markManualJournal(companyId, entry.id);
    await postJournalEntry(companyId, entry.id, userId);
    posted.push({
      billId: j.billId, billNumber: j.billNumber, amount: j.amount, reference: j.reference,
      journalEntryId: entry.id, entryNumber: entry.entryNumber ?? null,
    });
  }
  log.info('Posted undo-share journals', {
    companyId, paymentId: plan.paymentId, shareJournalId: plan.shareJournal.id, journals: posted.length,
  }, 'accounting');
  return posted;
}
