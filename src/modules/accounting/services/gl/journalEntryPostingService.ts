/**
 * Journal Entry Posting Service
 * Post and reverse journal entries with fiscal period and balance validation.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateJournalEntry } from '../../utils/doubleEntry';
import type { JournalEntry, JournalLineInput } from '../../types/gl.types';
import {
  getJournalEntryById,
  createJournalEntry,
  resolveUserUuid,
  mapEntryRow,
} from './journalEntryCrudService';
import { defaultHumanMeta, actorMeta, type PostingActorOpts } from './journalEntryMeta';
import {
  claimJournalReversal,
  releaseJournalReversalClaim,
  withReversalTransaction,
} from './journalEntryReversalClaim';
import { resolveReversalDate } from './journalEntryReversalDate';

// Re-exported: the MCP reverse tool and journalEntryService import it from here.
export { resolveReversalDate };

type Row = DbRow;

/**
 * Thrown when a journal entry cannot be posted because its target fiscal
 * period is not open. Lets callers (e.g. bank-rules auto-post) match on
 * `instanceof` instead of regexing the message, so future wording tweaks
 * don't silently change the swallow/re-throw boundary.
 */
export class ClosedFiscalPeriodError extends Error {
  readonly periodStatus: string;
  constructor(periodStatus: string) {
    super(`Cannot post to ${periodStatus} fiscal period`);
    this.name = 'ClosedFiscalPeriodError';
    this.periodStatus = periodStatus;
  }
}

/**
 * Thrown when an entry targets a GL account that has been deactivated.
 * Carries the offending account codes so a caller can act on them, and is
 * `instanceof`-matchable for the same reason ClosedFiscalPeriodError is:
 * automated posters decide swallow-vs-re-throw on the class, not the wording.
 */
export class InactiveAccountError extends Error {
  readonly accounts: string[];
  constructor(accounts: { code: string; name: string }[]) {
    const listed = accounts.map((a) => `${a.code} ${a.name}`).join(', ');
    super(
      `Cannot post to deactivated GL account${accounts.length === 1 ? '' : 's'}: ${listed}. ` +
        `Reactivate the account, or recode the line to an active one.`,
    );
    this.name = 'InactiveAccountError';
    this.accounts = accounts.map((a) => a.code);
  }
}

/**
 * Refuse if any line of `entryId` targets a deactivated GL account.
 *
 * Exported because two paths post with a direct UPDATE instead of calling
 * postJournalEntry, and both must still enforce this. postJournalEntry is the
 * canonical posting path; anything calling this directly is diverging from it
 * and should say why.
 */
export async function assertNoInactiveAccountLines(companyId: string, entryId: string): Promise<void> {
  const inactiveRows = (await sql`
    SELECT DISTINCT ga.account_code, ga.account_name
    FROM gl_journal_lines jl
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
    WHERE jl.journal_entry_id = ${entryId}
      AND jl.company_id = ${companyId}::UUID
      AND ga.is_active = false
    ORDER BY ga.account_code
  `) as Row[];
  if (inactiveRows.length > 0) {
    throw new InactiveAccountError(
      inactiveRows.map((r) => ({ code: String(r.account_code), name: String(r.account_name) })),
    );
  }
}

export async function postJournalEntry(companyId: string, id: string, userId: string): Promise<JournalEntry> {
  try {
    const entry = await getJournalEntryById(companyId, id);
    if (!entry) throw new Error(`Journal entry ${id} not found`);
    if (entry.status !== 'draft') throw new Error(`Cannot post entry with status: ${entry.status}`);

    if (entry.fiscalPeriodId) {
      const period = (await sql`
        SELECT status FROM fiscal_periods
        WHERE id = ${entry.fiscalPeriodId} AND company_id = ${companyId}::UUID
      `) as Row[];
      if (period.length > 0 && String(period[0]!.status) !== 'open') {
        throw new ClosedFiscalPeriodError(String(period[0]!.status));
      }
    }

    if (entry.lines) {
      const validation = validateJournalEntry(entry.lines.map(l => ({
        glAccountId: l.glAccountId,
        debit: l.debit,
        credit: l.credit,
      })));
      if (!validation.valid) throw new Error(`Entry not balanced: ${validation.errors.join('; ')}`);
    }

    // A deactivated account must not accept a new posting. is_active means the
    // account has been withdrawn from the chart, so posting to it contradicts
    // the flag outright -- and it is the one route by which an account can end
    // up inactive AND holding money despite the balance guard on
    // updateAccount/deleteAccount: deactivate while only drafts exist (balance
    // 0, correctly allowed), then post the draft.
    //
    // Refuse the WHOLE entry. Skipping the offending line would leave the
    // journal unbalanced, and the refusal has to land before the UPDATE so the
    // surrounding transaction commits nothing (the 400-after-write class).
    await assertNoInactiveAccountLines(companyId, id);

    const safePostUserId = await resolveUserUuid(userId);
    const rows = (await sql`
      UPDATE gl_journal_entries
      SET status = 'posted', posted_by = ${safePostUserId}::UUID, posted_at = NOW()
      WHERE id = ${id} AND company_id = ${companyId}
      RETURNING *
    `) as Row[];

    log.info('Posted journal entry', { id, entryNumber: String(rows[0]!.entry_number) }, 'accounting');
    return mapEntryRow(rows[0]!);
  } catch (err) {
    log.error('Failed to post journal entry', { id, error: err }, 'accounting');
    throw err;
  }
}

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
  opts?: PostingActorOpts & { reversalDate?: string },
): Promise<JournalEntry> {
  // One transaction around the whole reversal. Inside a request there already
  // is one and this runs on it; outside one (scripts/fixes, cron) it opens and
  // commits its own. That is what keeps the claim below from outliving the
  // contra it stands for: a crash anywhere in between rolls both back, and a
  // rerun repairs the entry instead of finding it permanently marked reversed.
  return withReversalTransaction({ companyId, userId }, async () => {
  try {
    const entry = await getJournalEntryById(companyId, id);
    if (!entry) throw new Error(`Journal entry ${id} not found`);
    if (entry.status !== 'posted') throw new Error('Can only reverse posted entries');
    // Double-reversal guard. The original KEEPS status='posted' after reversal
    // (see below), so status alone can no longer signal "already reversed";
    // reversed_at is the marker instead.
    if (entry.reversedAt) throw new Error('Journal entry already reversed');
    if (!entry.lines || entry.lines.length === 0) throw new Error('Entry has no lines');

    const reversalLines: JournalLineInput[] = entry.lines.map(l => ({
      glAccountId: l.glAccountId,
      debit: l.credit,
      credit: l.debit,
      description: `Reversal: ${l.description || ''}`,
      projectId: l.projectId,
      costCenterId: l.costCenterId,
    }));

    // Only entryDate is chosen here; createJournalEntry still derives the
    // fiscal period FROM that date, so the period can never disagree with it.
    // Why that date and not today: see journalEntryReversalDate.
    const originalDate = fmtDate(entry.entryDate);
    const reversalDate = await resolveReversalDate(companyId, originalDate, opts?.reversalDate);

    // Claim the reversal BEFORE any contra is written. The `entry.reversedAt`
    // guard above reads an unlocked row, so two overlapping callers both saw
    // NULL, both cleared it, and both posted a contra — leaving the reversed
    // accounts at the NEGATIVE of the original instead of zero. The claim is a
    // single predicated UPDATE: the loser gets zero rows and refuses here,
    // before it has created anything to clean up.
    if (!await claimJournalReversal(companyId, id, userId)) {
      throw new Error('Journal entry already reversed');
    }

    let reversalEntry: JournalEntry;
    try {
      reversalEntry = await createJournalEntry(companyId, {
        entryDate: reversalDate,
        description: `Reversal of ${entry.entryNumber}`,
        source: entry.source,
        lines: reversalLines,
      }, userId, actorMeta(opts) ?? defaultHumanMeta(userId));
    } catch (err) {
      // Nothing exists yet, but the claim does. Inside a request transaction the
      // rollback undoes it; outside one (cron, scripts) this is what stops a
      // failed attempt from leaving the entry permanently un-reversible.
      await releaseJournalReversalClaim(companyId, id);
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
      const deleted = (await sql`
        DELETE FROM gl_journal_entries
        WHERE id         = ${reversalEntry.id}::UUID
          AND company_id = ${companyId}::UUID
          AND status     = 'draft'
        RETURNING id
      `) as Row[];

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

    log.info('Reversed journal entry', { originalId: id, reversalId: reversalEntry.id }, 'accounting');
    return reversalEntry;
  } catch (err) {
    log.error('Failed to reverse journal entry', { id, error: err }, 'accounting');
    throw err;
  }
  });
}
