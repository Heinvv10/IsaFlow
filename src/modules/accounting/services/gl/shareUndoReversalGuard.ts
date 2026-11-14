/**
 * A share journal with live undo-share journals cannot be reversed (step 6 review round 2, breaker REPRO 10).
 *
 * void_payment's undo journals (`ap/shareUndoPost`) give a share's expense and VAT back for a bill and link to it by
 * `source_record_id`. Reversing the share afterwards gives the same amounts back a SECOND time — Velocity re-dates a
 * share by reverse-and-repost, so this is the ordinary way to do it. Refused: reverse those undos first (each is an
 * ordinary journal), then the share.
 *
 * WHERE IT RUNS (security review, TOCTOU). Authoritatively inside `reverseJournalEntry`, AFTER its claim — the
 * predicated UPDATE that row-locks the journal being reversed. An undo locks the same row FOR UPDATE before it reads
 * the share (`ap/shareUndoReads.lockShareJournal`), so the two serialise on it: a reversal that waited on an undo sees
 * the committed undo here and refuses (its claim released); an undo that waited on a reversal sees the share reversed
 * and refuses. A check before the claim could pass while an undo committed past it. MCP `reverse_journal_entry` also
 * asks it early, read-only, for its dry run; that read is not the guard.
 * Lock order, no cycle: reversal = the journal's row (claim) → journal-number lock; undo = bank line → payment → share
 * row → bills → payment journal head → journal-number locks. A reversal of a share takes no payment or bill lock.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export class ShareHasLiveUndosError extends Error {
  readonly code = 'SHARE_HAS_LIVE_UNDOS';
  constructor(entryNumber: string, undos: readonly string[]) {
    super(`${entryNumber} is the share journal of undo-share journal${undos.length === 1 ? '' : 's'} ${undos.join(', ')}, `
      + 'which already gave part of it back. Reversing it now would give that back a second time — reverse those undo '
      + 'journals first (reverse_journal_entry), then this one.');
    this.name = 'ShareHasLiveUndosError';
  }
}

/**
 * The live undo journals linked to `journalId` by `source_record_id` — the link, whatever the reference says (round 5).
 * Empty for every journal that is not a share: nothing else sets a journal's id as another journal's source record.
 */
export async function liveUndoSharesOf(companyId: string, journalId: string): Promise<string[]> {
  const rows = (await sql`
    SELECT COALESCE(entry_number, id::TEXT) AS n FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID AND source_record_id = ${journalId}::UUID
      AND status IN ('draft', 'posted') AND reversed_at IS NULL
    ORDER BY entry_number`) as DbRow[];
  return rows.map((r) => String(r.n));
}

export async function assertNoLiveUndoShares(companyId: string, journalId: string, entryNumber: string): Promise<void> {
  const undos = await liveUndoSharesOf(companyId, journalId);
  if (undos.length > 0) throw new ShareHasLiveUndosError(entryNumber, undos);
}
