/**
 * Reclassification batches — the set identity behind `post_reclassification_batch`.
 *
 * A move off `49775627 Unallocated Expense` is 419 lines and, dated to their own
 * entry dates, hundreds of journals. Without a batch id, undoing it means
 * finding every one of them by hand. With one, the set is addressable and each
 * journal is reversed through the ordinary `reverse_journal_entry` path — so the
 * undo lives in the audit trail like any other correction, rather than beside it
 * as an un-edit of posted history.
 *
 * Every function takes `companyId` first and fences on it. `gl_journal_lines`
 * has no composite `(id, company_id)` key, so a lookup trusting only the id
 * would read across tenants.
 *
 * Append-only from the app (mig 600 grants SELECT and INSERT only): a reversed
 * reclassification must not read as one that never happened.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface ReclassBatchInput {
  tool: string;
  sourceAccountId: string;
  targetAccountId: string;
  lineCount: number;
  /** The single date every journal carried, or null when dated per source line. */
  postingDate: string | null;
  idempotencyKey: string | null;
}

/** Opens a batch and returns its id. Caller must be inside the request tx. */
export async function createReclassBatch(
  companyId: string,
  userId: string,
  input: ReclassBatchInput,
): Promise<string> {
  const rows = (await sql`
    INSERT INTO reclassification_batches
      (company_id, created_by, tool, source_account_id, target_account_id,
       line_count, posting_date, idempotency_key)
    VALUES
      (${companyId}::UUID, ${userId}, ${input.tool}, ${input.sourceAccountId}::UUID,
       ${input.targetAccountId}::UUID, ${input.lineCount},
       ${input.postingDate}::DATE, ${input.idempotencyKey})
    RETURNING id
  `) as DbRow[];
  const id = rows[0]?.id;
  // No row back means the INSERT did not happen (an RLS refusal returns zero
  // rows rather than raising). Throwing is what rolls the whole batch back —
  // returning a bogus id would leave posted journals nothing could find.
  if (!id) throw new Error('Failed to open the reclassification batch');
  return String(id);
}

export interface ReclassBatchLine {
  sourceLineId: string;
  journalEntryId: string;
}

/**
 * Records which source line each posted reclassification journal moved.
 *
 * Two guards depend on these rows and both would fail open without them: a
 * second batch would move the same line again, and a later proposal would offer
 * the CONTRA leg of this one as a candidate — moving the correction rather than
 * the amount.
 *
 * Throws unless every line was recorded. A posted journal with no batch row is
 * a reclassification outside the set the batch id exists to name.
 */
export async function recordReclassBatchLines(
  companyId: string,
  batchId: string,
  lines: readonly ReclassBatchLine[],
): Promise<void> {
  if (lines.length === 0) return;
  const sourceIds = lines.map((l) => l.sourceLineId);
  const entryIds = lines.map((l) => l.journalEntryId);

  // UNNEST rather than a loop: 500 lines would otherwise be 500 round trips
  // while the batch holds one connection's locks.
  const rows = (await sql`
    INSERT INTO reclassification_batch_lines
      (company_id, batch_id, source_line_id, journal_entry_id)
    SELECT ${companyId}::UUID, ${batchId}::UUID, t.src, t.je
      FROM UNNEST(${sourceIds}::UUID[], ${entryIds}::UUID[]) AS t(src, je)
    RETURNING id
  `) as DbRow[];
  if (rows.length !== lines.length) {
    throw new Error('Reclassification batch did not record every moved line');
  }
}

export interface ReclassBatchJournal {
  journalEntryId: string;
  entryNumber: string | null;
  entryDate: string;
  /** Set once the journal has been reversed — the batch's undo is done. */
  reversedAt: string | null;
  sourceLineCount: number;
}

export interface ReclassBatchDetail {
  batchId: string;
  sourceAccountId: string;
  targetAccountId: string;
  postingDate: string | null;
  lineCount: number;
  journals: ReclassBatchJournal[];
}

/**
 * A batch and the journals it posted, or `null` when the batch does not exist
 * IN THIS COMPANY. `null` and "another tenant's batch" are deliberately the
 * same answer — a distinct reply would be an existence oracle.
 */
export async function getReclassBatch(
  companyId: string,
  batchId: string,
): Promise<ReclassBatchDetail | null> {
  const header = (await sql`
    SELECT id, source_account_id, target_account_id, posting_date, line_count
      FROM reclassification_batches
     WHERE id = ${batchId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const h = header[0];
  if (!h) return null;

  const rows = (await sql`
    SELECT l.journal_entry_id, je.entry_number, je.entry_date, je.reversed_at,
           COUNT(*)::INT AS source_line_count
      FROM reclassification_batch_lines l
      JOIN gl_journal_entries je
        ON je.id = l.journal_entry_id AND je.company_id = l.company_id
     WHERE l.company_id = ${companyId}::UUID AND l.batch_id = ${batchId}::UUID
     GROUP BY l.journal_entry_id, je.entry_number, je.entry_date, je.reversed_at
     ORDER BY je.entry_date, je.entry_number
  `) as DbRow[];

  const asDate = (v: unknown): string =>
    v instanceof Date ? v.toISOString().slice(0, 10) : String(v);

  return {
    batchId: String(h.id),
    sourceAccountId: String(h.source_account_id),
    targetAccountId: String(h.target_account_id),
    postingDate: h.posting_date === null ? null : asDate(h.posting_date),
    lineCount: Number(h.line_count ?? 0),
    journals: rows.map((r) => ({
      journalEntryId: String(r.journal_entry_id),
      entryNumber: r.entry_number === null ? null : String(r.entry_number),
      entryDate: asDate(r.entry_date),
      reversedAt:
        r.reversed_at === null || r.reversed_at === undefined
          ? null
          : new Date(String(r.reversed_at)).toISOString(),
      sourceLineCount: Number(r.source_line_count ?? 0),
    })),
  };
}
