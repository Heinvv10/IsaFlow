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
import { defaultHumanMeta } from './journalEntryMeta';
import { getPeriodStatusForDate } from './periodStatusService';

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
 * With one, the caller wins — including over the closed-period fallback, which
 * is the case people actually ask for (correcting a closed month from the open
 * one). Two guards, and deliberately only two:
 *
 *   - the value must be a real YYYY-MM-DD day. It is interpolated into a DATE
 *     column, where a malformed value raises 22P02 and reaches the caller as a
 *     generic failure that names nothing.
 *   - it must not PRECEDE the entry being reversed. A correction landing before
 *     the thing it corrects is nonsense in every period-bounded report.
 *
 * Whether the TARGET period is open is NOT checked here. createJournalEntry
 * derives the fiscal period from this date and postJournalEntry raises
 * ClosedFiscalPeriodError, so a second check here could only drift from the one
 * that actually governs the write.
 */
async function resolveReversalDate(
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
  return requested;
}

export async function reverseJournalEntry(
  companyId: string,
  id: string,
  userId: string,
  opts?: { postingAgent?: string; reversalDate?: string },
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
    }, userId, opts?.postingAgent ? { postingAgent: opts.postingAgent } : defaultHumanMeta(userId));

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

    log.info('Reversed journal entry', { originalId: id, reversalId: reversalEntry.id }, 'accounting');
    return reversalEntry;
  } catch (err) {
    log.error('Failed to reverse journal entry', { id, error: err }, 'accounting');
    throw err;
  }
}
