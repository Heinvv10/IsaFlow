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
import { getPeriodStatusForDate } from './periodStatusService';
import { releaseCapturedDocumentPostingClaim } from '../capture/capturePostingClaimRelease';

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
/** A calendar date, and a real one — `2026-02-30` matches the shape but is not a day. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Which date the contra carries.
 *
 * Without an explicit date this is the default described above: the original
 * entry's date when its period is open, today when it is closed.
 *
 * With one, the caller wins over the ORIGINAL period's status — that fallback is
 * exactly what people ask to override (correcting a closed month from the open
 * one). Three guards:
 *
 *   - the value must be a real YYYY-MM-DD day. It is interpolated into a DATE
 *     column, where a malformed value raises 22P02 and reaches the caller as a
 *     generic failure that names nothing. '2026-02-30' matches the shape and is
 *     not a day, so the date is constructed and compared back.
 *   - it must not PRECEDE the entry being reversed. A correction landing before
 *     the thing it corrects is nonsense in every period-bounded report.
 *   - its fiscal period must EXIST and be open.
 *
 * That third guard was initially left to postJournalEntry, on the reasoning that
 * a second check could only drift from the one governing the write. That
 * reasoning was WRONG, and an adversarial review caught it:
 *
 *   postJournalEntry guards its closed-period check behind
 *   `if (entry.fiscalPeriodId)`, and createJournalEntry leaves that column NULL
 *   when NO fiscal_periods row covers the entry date. So a date in a fiscal
 *   year nobody has created yet — '9999-12-31', or a typo'd year — skipped the
 *   check entirely and POSTED, with fiscal_period_id NULL, permanently outside
 *   every period-bounded report: trial balance, VAT201, AFS.
 *
 * The underlying NULL-period hole is older than this parameter and reachable by
 * any caller of createJournalEntry. What this parameter changed is that an
 * arbitrary date became remotely selectable, so it is closed HERE, on the path
 * that introduced the reach. getPeriodStatusForDate already distinguishes
 * `no_period` from `closed`, and the two get different messages because the
 * remedies differ: create the fiscal year, versus re-open the period.
 */
/**
 * Exported so a caller that must distinguish a REFUSAL from a FAILURE can run
 * these guards first. It is read-only, so calling it twice costs two period
 * lookups and nothing else. `apply`-style MCP tools need this: only pre-write
 * validation may return a `toolError`, and once `reverseJournalEntry` has been
 * entered a caller cannot tell a bad date from a failure after the contra
 * posted.
 */
export async function resolveReversalDate(
  companyId: string,
  originalDate: string,
  requested: string | undefined,
): Promise<string> {
  if (requested === undefined) {
    const originalPeriod = await getPeriodStatusForDate(companyId, originalDate);
    // fmtDate(new Date()), not toISOString — between 00:00 and 02:00 SAST the
    // latter stamps yesterday.
    return originalPeriod === 'open' ? originalDate : fmtDate(new Date());
  }
  if (!isCalendarDate(requested)) {
    throw new Error(`reversal_date must be a real calendar date in YYYY-MM-DD format, got "${requested}"`);
  }
  // String comparison is safe and total for zero-padded ISO dates.
  if (requested < originalDate) {
    throw new Error(
      `reversal_date ${requested} is before the entry it reverses (${originalDate}). `
      + 'A correction cannot be dated earlier than the entry it corrects.',
    );
  }
  // The TARGET date's period, not the original's. Refused BEFORE
  // createJournalEntry inserts anything, so there is no draft to clean up and
  // the caller is told which of the two problems it has.
  const targetPeriod = await getPeriodStatusForDate(companyId, requested);
  if (targetPeriod === 'no_period') {
    throw new Error(
      `No fiscal period covers reversal_date ${requested}. `
      + 'Create the fiscal year first — posting outside every period would leave the '
      + 'reversal invisible to the trial balance, the VAT201 and the AFS.',
    );
  }
  if (targetPeriod !== 'open') {
    throw new Error(`The fiscal period covering reversal_date ${requested} is closed.`);
  }
  return requested;
}

export async function reverseJournalEntry(
  companyId: string,
  id: string,
  userId: string,
  opts?: PostingActorOpts & { reversalDate?: string },
): Promise<JournalEntry> {
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
      buId: l.buId,
      vatType: l.vatType,
    }));

    // A correction belongs in the period it corrects. Dating every reversal to
    // TODAY moved the correction into a later period than the entry it undoes:
    // the two no longer net to zero in any period-bounded report, and when the
    // pair straddles a VAT period the return for the original period stays
    // overstated while the next one is understated.
    //
    // So: date the reversal to the ORIGINAL entry_date when that period is
    // still open, and fall back to today only when it is not. The fallback is
    // what the previous unconditional-today rule was really protecting — a
    // closed original period must not make old documents permanently
    // un-cancellable, and postJournalEntry would throw ClosedFiscalPeriodError.
    //
    // Only entryDate is chosen here; createJournalEntry still derives the
    // fiscal period FROM that date, so the period can never disagree with it.
    //
    // All of that is the DEFAULT. A caller may name the date instead — see
    // resolveReversalDate — and when it does, the original period is not even
    // consulted: the fallback it drives is precisely what is being overridden.
    const originalDate = fmtDate(entry.entryDate);
    const reversalDate = await resolveReversalDate(companyId, originalDate, opts?.reversalDate);

    const reversalEntry = await createJournalEntry(companyId, {
      entryDate: reversalDate,
      description: `Reversal of ${entry.entryNumber}`,
      source: entry.source,
      lines: reversalLines,
    }, userId, actorMeta(opts) ?? defaultHumanMeta(userId));

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
      await sql`
        DELETE FROM gl_journal_entries
        WHERE id         = ${reversalEntry.id}::UUID
          AND company_id = ${companyId}::UUID
          AND status     = 'draft'
      `;
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
    // Both link-back UPDATEs must succeed together. We use the request-scoped
    // sql client (auto-routed via AsyncLocalStorage) instead of withTransaction
    // here — withTransaction would acquire a separate pool client and deadlock
    // against the rows already locked by the request-scoped tx (e.g. the
    // reversal JE we just inserted/posted in this same request).
    await sql`
      UPDATE gl_journal_entries
      SET reversed_by = ${userId}::UUID, reversed_at = NOW()
      WHERE id = ${id} AND company_id = ${companyId}
    `;
    await sql`
      UPDATE gl_journal_entries
      SET reversal_of_id = ${id}::UUID
      WHERE id = ${reversalEntry.id} AND company_id = ${companyId}
    `;

    // A reversed capture posting journal releases the document's posting claim,
    // so `document-capture-action`'s "Reverse the journal or invoice first" is
    // an instruction that works. Nothing happens unless this entry came from a
    // captured document, and the helper still refuses while any other live
    // journal or uncancelled supplier invoice references it.
    const claimReleased = entry.sourceDocumentId
      ? await releaseCapturedDocumentPostingClaim(companyId, entry.sourceDocumentId)
      : false;

    log.info('Reversed journal entry',
      { originalId: id, reversalId: reversalEntry.id, claimReleased }, 'accounting');
    return reversalEntry;
  } catch (err) {
    log.error('Failed to reverse journal entry', { id, error: err }, 'accounting');
    throw err;
  }
}
