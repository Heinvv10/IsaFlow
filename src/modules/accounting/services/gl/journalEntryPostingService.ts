/** Post and reverse journals with fiscal-period and balance validation. */

import { sql, withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { JournalEntry } from '../../types/gl.types';
import { getJournalEntryById, createJournalEntry } from './journalEntryCrudService';
import { defaultHumanMeta, actorMeta, type PostingActorOpts } from './journalEntryMeta';
import { buildReversalLines, type ReversalEntry } from './reversalLines';
import {
  claimJournalReversal,
  releaseJournalReversalClaim,
  withReversalTransaction,
} from './journalEntryReversalClaim';
import { resolveReversalDate, resolveReversalDateDetailed, ReversalPeriodError } from './journalEntryReversalDate';
import { VatPeriodLockedError } from './journalVatLockGuard';
import { releaseCapturedDocumentPostingClaim } from '../capture/capturePostingClaimRelease';
import { refuseReversingSettlementJournal } from '../ap/provisionalSettlementGuards';
import { refuseReversingCompletedCash } from '../bank/reconciledCash';
import { refuseReversalAgainstPayRun } from '../payroll/payrollJournalReversalGuard';
import { postJournalEntry } from './journalEntryPostService';
import { cleanUpAfter } from './reversalCleanup';
import {
  LateClaimCompanionReversalError, copyLateClaimBaseToReversal, planLateClaimCompanionReversal,
} from './vatLateClaimSplit';

/** A reversal of a late-claim original carries its companion's reversal (vatLateClaimSplit.ts). */
export type ReversalWithLateClaim = ReversalEntry & { lateClaimReversal?: ReversalEntry };

// Re-exported: the MCP reverse tool and journalEntryService import them from here.
export { resolveReversalDate, resolveReversalDateDetailed, ReversalPeriodError, VatPeriodLockedError };
export type { ReversalEntry } from './reversalLines';

type Row = DbRow;
type ReverseOpts = PostingActorOpts & { reversalDate?: string; lateClaimCascade?: boolean; cashLinesLocked?: readonly string[] };


import {
  ClosedFiscalPeriodError,
  InactiveAccountError,
  assertNoInactiveAccountLines,
} from './journalEntryPostingGuards';

// Defined in `journalEntryPostingGuards.ts`; re-exported because every caller
// — and every test that mocks this module — reaches them through here.
export { ClosedFiscalPeriodError, InactiveAccountError, assertNoInactiveAccountLines };

export type { PostJournalOpts } from './vatLateClaimPlan';
// Split out to hold this file under 300 lines; re-exported because every
// caller — and every test that mocks this module — reaches it through here.
export { postJournalEntry } from './journalEntryPostService';

/**
 * Post the contra entry that reverses `id`.
 *
 * `opts.postingAgent` stamps the CONTRA (the original keeps whatever it was
 * posted with). A reversal is a real posted journal, so an automated caller
 * that does not stamp it lands on `human:<userId>` and its correction becomes
 * invisible to every posting_agent-based review surface. Callers that pass
 * nothing keep exactly that human default.
 */
export async function reverseJournalEntry(
  companyId: string,
  id: string,
  userId: string,
  // lateClaimCascade: internal — set only by the cascade below. cashLinesLocked: internal — the statement lines the
  // journal-reversal gate locked (`bank/reconciledCash`, D12); a tied line outside it is a retry.
  opts?: ReverseOpts,
): Promise<ReversalWithLateClaim> {
  // One transaction around the whole reversal. Inside a request there already
  // is one and this runs on it; outside one (scripts/fixes, cron) it opens and
  // commits its own. That is what keeps the claim below from outliving the
  // contra it stands for: a crash anywhere in between rolls both back, and a
  // rerun repairs the entry instead of finding it permanently marked reversed.
  return withReversalTransaction({ companyId, userId }, async () => {
    // A late-claim original reverses its companion with it, all or nothing; the
    // companion's reversal is planned (and refused) before any write.
    const companion = opts?.lateClaimCascade ? null : await planLateClaimCompanionReversal(companyId, id);
    const body = () => reverseJournalEntryInner(companyId, id, userId, opts, companion);
    return companion ? withSavepoint('reverse_late_claim', body) : body();
  });
}

async function reverseJournalEntryInner(
  companyId: string,
  id: string,
  userId: string,
  opts: ReverseOpts | undefined,
  companion: { id: string } | null,
): Promise<ReversalWithLateClaim> {
  try {
    const entry = await getJournalEntryById(companyId, id);
    if (!entry) throw new Error(`Journal entry ${id} not found`);
    if (entry.status !== 'posted') throw new Error('Can only reverse posted entries');
    // Double-reversal guard. The original KEEPS status='posted' after reversal
    // (see below), so status alone can no longer signal "already reversed";
    // reversed_at is the marker instead.
    if (entry.reversedAt) throw new Error('Journal entry already reversed');
    if (!entry.lines || entry.lines.length === 0) throw new Error('Entry has no lines');
    if (entry.source === 'auto_vat_late_claim' && !opts?.lateClaimCascade) {
      throw new LateClaimCompanionReversalError(entry.entryNumber);
    }
    await refuseReversalAgainstPayRun(companyId, entry); // W3-01: a pay run's journal, judged by the ledger, under its locks

    // Debits and credits swap; every dimension and the VAT classification come
    // across unchanged EXCEPT a legacy tag naming another company's project,
    // cost centre, business unit or CC1/CC2 analysis code, which is dropped
    // rather than copied into a journal `assertJournalLinesOwned` would refuse —
    // refusing here would leave the entry permanently un-reversible. See
    // reversalLines.ts.
    const carried = await buildReversalLines(companyId, entry.lines);

    // Only entryDate is chosen here; createJournalEntry still derives the
    // fiscal period FROM that date, so the period can never disagree with it.
    // Why that date and not today: see journalEntryReversalDate.
    const originalDate = fmtDate(entry.entryDate);
    // The original's lines let a locked VAT period ROLL a defaulted date
    // forward (and refuse a named one inside it) — journalEntryReversalDate.
    const { date: reversalDate, vatLockRoll } = await resolveReversalDateDetailed(
      companyId, originalDate, opts?.reversalDate, entry.lines);

    // Claim the reversal BEFORE any contra is written. The `entry.reversedAt`
    // guard above reads an unlocked row, so two overlapping callers both saw
    // NULL, both cleared it, and both posted a contra — leaving the reversed
    // accounts at the NEGATIVE of the original instead of zero. The claim is a
    // single predicated UPDATE: the loser gets zero rows and refuses here,
    // before it has created anything to clean up.
    if (!await claimJournalReversal(companyId, id, userId)) {
      throw new Error('Journal entry already reversed');
    }
    // R-127: either half of a bank-first settlement — AFTER the claim (D8 round
    // 4, B1). Before it, this was an unlocked read of supplier_payments that an
    // approval settling the provisional (which locks it, and since D8 its chain
    // head) could commit right past. Now the claim's row lock waits for that
    // approval and this read sees its settlement. A refusal releases the claim:
    // withAuth COMMITs a 4xx, and a stranded claim reads as reversed.
    try {
      await refuseReversingSettlementJournal(companyId, entry);
      // D12 round 3: statement cash a COMPLETED reconciliation signed off — asked under the claim, read-only.
      await refuseReversingCompletedCash(companyId, id, opts?.cashLinesLocked);
    } catch (err) {
      await releaseJournalReversalClaim(companyId, id);
      throw err;
    }

    let reversalEntry: JournalEntry;
    try {
      reversalEntry = await createJournalEntry(companyId, {
        entryDate: reversalDate,
        description: `Reversal of ${entry.entryNumber}`,
        source: entry.source,
        lines: carried.lines,
      }, userId, actorMeta(opts) ?? defaultHumanMeta(userId), {
        dimensionAssignmentMode: 'historical-copy',
        // A reversal mirrors posted lines — including a late claim's clearing leg.
        // Not a reversal OF a reversal: undoing the undo of a late original would
        // re-park its VAT on the clearing account with no companion to clear it,
        // so that one faces the clearing-account guard like any other journal.
        reversal: !entry.reversalOfId,
      });
    } catch (err) {
      // Nothing exists yet, but the claim does. Inside a request transaction the
      // rollback undoes it; outside one (cron, scripts) this is what stops a
      // failed attempt from leaving the entry permanently un-reversible.
      await cleanUpAfter(err, () => releaseJournalReversalClaim(companyId, id));
      throw err;
    }

    try {
      await postJournalEntry(companyId, reversalEntry.id, userId);
    } catch (err) {
      // createJournalEntry has already INSERTed a draft. If posting it fails —
      // the fiscal period flipping closed between the read above and this post
      // is the realistic race — the draft would otherwise dangle in the GL
      // forever: unposted, unlinked (reversal_of_id is set below, not yet), and
      // with the original still unmarked as reversed. Delete it, then re-throw
      // so the caller still sees the failure.
      //
      // `AND status = 'draft'` is load-bearing, not defensive dressing: it is
      // what makes this incapable of touching a posted entry. If postJournalEntry
      // threw AFTER its status UPDATE landed, the row is 'posted' and this DELETE
      // matches nothing. gl_journal_lines cascades from this row
      // (gl_journal_lines_journal_entry_id_fkey ON DELETE CASCADE), so the draft's
      // lines go with it and no posted line is ever reachable from here.
      // On an aborted transaction (a lock timeout in the post) `cleanUpAfter` re-throws the post's error.
      const deleted = await cleanUpAfter(err, async () => (await sql`
        DELETE FROM gl_journal_entries
        WHERE id         = ${reversalEntry.id}::UUID
          AND company_id = ${companyId}::UUID
          AND status     = 'draft'
        RETURNING id
      `) as Row[]);

      // Release the claim ONLY when the contra is genuinely gone. If
      // postJournalEntry threw AFTER its status UPDATE landed, the DELETE above
      // matched nothing and a POSTED contra survives — unlinked, so the unique
      // index cannot see it. Clearing reversed_at there would invite a retry
      // that posts a second one. Leaving the claim set is the honest state: a
      // posted contra exists, so the original really is reversed, and the
      // orphan is named in the log for repair.
      if (deleted.length > 0) {
        await releaseJournalReversalClaim(companyId, id);
      } else {
        log.error(
          'Reversal post failed but the contra is not a draft — claim kept, contra left unlinked',
          { originalId: id, contraId: reversalEntry.id },
          'accounting',
        );
      }
      throw err;
    }

    // Standard-accounting reversal: the original stays status='posted' and the
    // posted contra entry offsets it, so the pair nets to zero in every
    // posted-only report and in the gl_account_balances cache. "Reversed" is now
    // METADATA (reversed_at / reversed_by / reversal_of_id), NOT a status flip —
    // flipping the original out of 'posted' used to drop it from posted-only
    // reports while the contra stayed, driving accounts to the NEGATIVE of the
    // original instead of zero.
    //
    // reversed_at / reversed_by were already written by the claim above; only
    // the contra's link back to the original is left. We use the request-scoped
    // sql client (auto-routed via AsyncLocalStorage) instead of withTransaction
    // here — withTransaction would acquire a separate pool client and deadlock
    // against the rows already locked by the request-scoped tx (e.g. the
    // reversal JE we just inserted/posted in this same request).
    try {
      await sql`
        UPDATE gl_journal_entries
        SET reversal_of_id = ${id}::UUID
        WHERE id = ${reversalEntry.id} AND company_id = ${companyId}
      `;
    } catch (err) {
      // ux_gl_je_reversal_of (migration 619). The claim makes this unreachable
      // in the product — it is the storage-layer backstop for a caller that
      // wrote reversed_at by hand — so surface the same wording the claim uses
      // rather than a raw constraint name in a 500.
      if (typeof err === 'object' && err !== null
        && (err as { constraint?: unknown }).constraint === 'ux_gl_je_reversal_of') {
        throw new Error('Journal entry already reversed');
      }
      throw err;
    }
    // A companion's contra carries each claim's base negated (vatLateClaimBasis).
    if (entry.source === 'auto_vat_late_claim') await copyLateClaimBaseToReversal(companyId, id, reversalEntry.id);

    // A reversed capture journal releases its document's posting claim, so "Reverse the journal
    // first" works; the helper still refuses while another live journal or invoice references it.
    // The document is re-read, not taken from `entry`: that read was unlocked, and a provisional
    // evidence attach that committed while the claim waited set source_document_id after it (R-107).
    const [current] = (await sql`
      SELECT source_document_id FROM gl_journal_entries
      WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`) as Row[];
    const claimReleased = current?.source_document_id
      ? await releaseCapturedDocumentPostingClaim(companyId, String(current.source_document_id)) : false;
    log.info('Reversed journal entry',
      { originalId: id, reversalId: reversalEntry.id, claimReleased }, 'accounting');
    // The count rides on the returned entry so every caller — the REST action
    // route passes this straight through — can tell the operator that the
    // contra is not tag-for-tag identical to what it reverses.
    // vatLockRoll rides the same way, so a caller can say the contra was dated
    // later than the default because a filed VAT period was in the way.
    const lateClaimReversal = companion ? await reverseJournalEntry(companyId, companion.id, userId,
      { ...opts, reversalDate: undefined, lateClaimCascade: true, cashLinesLocked: undefined }) : undefined;
    return {
      ...reversalEntry, foreignDimensionDroppedLines: carried.droppedLineCount, vatLockRoll,
      ...(lateClaimReversal ? { lateClaimReversal } : {}),
    };
  } catch (err) {
    log.error('Failed to reverse journal entry', { id, error: err }, 'accounting');
    throw err;
  }
}
