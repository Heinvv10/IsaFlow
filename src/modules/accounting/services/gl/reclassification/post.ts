/**
 * Posting a reclassification batch.
 *
 * Everything in this file is a WRITE, and the rules on this side of the
 * boundary are the opposite of the pre-write ones. `registry.call()` gives a
 * write tool exactly ONE savepoint, and that savepoint unwinds only on a THROW:
 * a `catch → toolError` returns normally, the savepoint RELEASES, and the
 * transport's HTTP 200 COMMITs whatever already posted. A half-posted
 * reclassification is a ledger where some of an account's cost has moved and the
 * rest has not — worse than one that failed outright. So nothing here catches.
 *
 * ALL-OR-NOTHING is therefore the property, not an aspiration: the caller opens
 * no savepoint of its own and rethrows everything.
 *
 * It still posts NEW journals — see ./journals.ts. `gl_journal_lines` is read
 * and never updated.
 */

import { log } from '@/lib/logger';
import { createJournalEntry } from '../journalEntryCrudService';
import { postJournalEntry } from '../journalEntryPostingService';
import type { PostingActorOpts } from '../journalEntryMeta';
import { actorMeta } from '../journalEntryMeta';
import type { ReclassJournalDraft } from './journals';
import { createReclassBatch, recordReclassBatchLines } from './batchService';

export interface PostedReclassJournal {
  journalEntryId: string;
  entryNumber: string | null;
  date: string;
  fiscalPeriodId: string | null;
  lineCount: number;
  totalDebit: number;
  totalCredit: number;
}

export interface PostedReclassBatch {
  batchId: string;
  journals: PostedReclassJournal[];
  movedLineCount: number;
}

export interface PostReclassInput {
  tool: string;
  sourceAccountId: string;
  targetAccountId: string;
  postingDate: string | null;
  idempotencyKey: string | null;
  drafts: readonly ReclassJournalDraft[];
  actor?: PostingActorOpts;
}

/**
 * Posts every draft, then records the batch.
 *
 * The batch row is opened AFTER the journals for the same reason
 * `bulk_allocate_bank_transactions` opens its own late: `line_count` should be
 * what the batch actually posted, and the journal ids being recorded do not
 * exist until the journals do.
 *
 * `fiscal_period_id` is asserted non-null on every journal before it is
 * recorded. `createJournalEntry` leaves the column NULL when no `fiscal_periods`
 * row covers the date and the auto-create window does not reach it, and
 * `postJournalEntry` skips its closed-period check behind `if
 * (entry.fiscalPeriodId)` — so such an entry POSTS, permanently outside the
 * trial balance, the VAT201 and the AFS. The assertion throws, which unwinds the
 * whole batch, because a reclassification nobody's reports can see is worse than
 * one that did not happen.
 */
export async function postReclassBatch(
  companyId: string,
  userId: string,
  input: PostReclassInput,
): Promise<PostedReclassBatch> {
  const posted: PostedReclassJournal[] = [];
  const batchLines: { sourceLineId: string; journalEntryId: string }[] = [];

  for (const draft of input.drafts) {
    // Sequential, not Promise.all: these share the one pg client the request
    // transaction holds, and concurrent statements on it corrupt the savepoint
    // stack (postgresql-gotchas §36).
    const entry = await createJournalEntry(
      companyId,
      {
        entryDate: draft.date,
        description: draft.description,
        // `auto_adjustment`, not a new `reclassification` source. `source` is
        // CHECK-constrained on gl_journal_entries, and widening that constraint
        // takes an ACCESS EXCLUSIVE lock and a full validation scan on the
        // busiest table in the schema — which blocks every posting — for a
        // value that carries no load-bearing meaning here. What a
        // reclassification journal IS gets recorded exactly, and indexed, in
        // `reclassification_batch_lines`; the contra probe reads that, not this
        // column. A reclassification is an adjustment journal, so the value is
        // accurate rather than a fudge, and the description names both accounts.
        source: 'auto_adjustment',
        lines: draft.lines,
      },
      userId,
      // Stamped as the agent. Without it `createJournalEntry` falls back to
      // `defaultHumanMeta(userId)` and a reclassification of hundreds of posted
      // lines is affirmatively labelled as the token owner's own typing, and
      // drops out of `list_agent_postings`.
      actorMeta(input.actor),
      { dimensionAssignmentMode: 'historical-copy' },
    );

    if (!entry.fiscalPeriodId) {
      throw new Error(
        `No fiscal period covers ${draft.date}. A reclassification journal with no ` +
          'period is invisible to the trial balance, the VAT201 and the AFS — ' +
          'create the fiscal year first.',
      );
    }

    // No catch. A closed period, a deactivated account or an unbalanced entry
    // must reach the registry's savepoint; flattening it here would leave the
    // journals already posted behind a reply that says the call failed.
    await postJournalEntry(companyId, entry.id, userId);

    posted.push({
      journalEntryId: entry.id,
      entryNumber: entry.entryNumber ?? null,
      date: draft.date,
      fiscalPeriodId: entry.fiscalPeriodId,
      lineCount: draft.lines.length,
      totalDebit: draft.totalDebit,
      totalCredit: draft.totalCredit,
    });
    for (const sourceLineId of draft.sourceLineIds) {
      batchLines.push({ sourceLineId, journalEntryId: entry.id });
    }
  }

  const batchId = await createReclassBatch(companyId, userId, {
    tool: input.tool,
    sourceAccountId: input.sourceAccountId,
    targetAccountId: input.targetAccountId,
    lineCount: batchLines.length,
    postingDate: input.postingDate,
    idempotencyKey: input.idempotencyKey,
  });
  await recordReclassBatchLines(companyId, batchId, batchLines);

  log.info(
    'Posted reclassification batch',
    {
      batchId,
      journals: posted.length,
      movedLines: batchLines.length,
      sourceAccountId: input.sourceAccountId,
      targetAccountId: input.targetAccountId,
    },
    'accounting',
  );

  return { batchId, journals: posted, movedLineCount: batchLines.length };
}
