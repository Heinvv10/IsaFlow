/**
 * Which posted lines a reclassification may move, and why each of the rest may
 * not.
 *
 * A reclassification does NOT rewrite the lines it selects. It reads them so it
 * can post a NEW journal that contras the source account and re-applies the
 * amount to the target — see ./journals.ts. Nothing in this file or its callers
 * updates `gl_journal_lines.gl_account_id`, and nothing should: rewriting
 * posted history silently changes a trial balance somebody may already have
 * signed, and leaves an auditor with no way to see the original classification.
 *
 * The partition is PURE and separate from the query, for the reason
 * `bulkAllocationSkip` is: the dry run and the live call must reach the same
 * verdict from the same read, or a dry run that passes where the real call
 * refuses is worse than no dry run at all.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** One posted line on the source account, with everything the guards need. */
export interface CandidateRow {
  line_id: string;
  journal_entry_id: string;
  entry_number: string | null;
  entry_date: string;
  debit: string | number | null;
  credit: string | number | null;
  description: string | null;
  project_id: string | null;
  cost_center_id: string | null;
  /** The ENTRY carries a reversal; its lines have already been contra'd. */
  reversed: boolean;
  /** `open` / `closed` / `locked`, or null when no period covers the entry. */
  period_status: string | null;
  has_period: boolean;
  /** A live earlier batch already moved this line. */
  already_reclassified: boolean;
  /** This line IS the contra leg an earlier reclassification posted. */
  is_reclass_contra: boolean;
  /** The entry date falls inside a filed VAT period. */
  vat_period_locked: boolean;
}

/** A line that WILL move, in the shape the journal builder consumes. */
export interface ReclassCandidate {
  lineId: string;
  journalEntryId: string;
  entryNumber: string | null;
  entryDate: string;
  debit: number;
  credit: number;
  description: string | null;
  projectId: string | null;
  costCenterId: string | null;
}

/** A line that will NOT move, and the machine-stable reason. */
export interface ReclassSkip {
  lineId: string;
  journalEntryId: string;
  entryNumber: string | null;
  entryDate: string;
  amount: number;
  reason: ReclassSkipReason;
}

export type ReclassSkipReason =
  | 'entry_reversed'
  | 'already_reclassified'
  | 'reclassification_contra'
  | 'zero_amount'
  | 'vat_period_locked'
  | 'source_period_closed'
  | 'source_period_missing';

export interface PartitionOptions {
  /**
   * When set, every reclassification journal is dated HERE instead of at its
   * source line's own date — so the source line's period being closed no longer
   * bars the move, because that period is not being written to. The caller
   * validates this date's own period before it gets here.
   */
  postingDate: string | null;
  /**
   * True when the source or the target is a VAT control account. Only then does
   * a filed VAT period bind: a move between two ordinary expense accounts
   * changes no box on a return that has already gone to SARS.
   */
  vatRelevant: boolean;
}

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

/**
 * The reasons are ORDERED, and the order is the message the caller gets. A line
 * on a reversed entry in a closed period is reported as reversed, because that
 * is the fact a human needs first: re-opening the period would not make it
 * movable.
 */
function skipReasonFor(row: CandidateRow, opts: PartitionOptions): ReclassSkipReason | null {
  if (row.reversed) return 'entry_reversed';
  if (row.is_reclass_contra) return 'reclassification_contra';
  if (row.already_reclassified) return 'already_reclassified';
  if (num(row.debit) === 0 && num(row.credit) === 0) return 'zero_amount';
  if (opts.vatRelevant && row.vat_period_locked) return 'vat_period_locked';
  // Both of these are about writing INTO the source line's own period, so both
  // fall away once the caller names a posting date of its own.
  if (opts.postingDate === null) {
    if (!row.has_period) return 'source_period_missing';
    if (row.period_status !== 'open') return 'source_period_closed';
  }
  return null;
}

export interface Partitioned {
  movable: ReclassCandidate[];
  skipped: ReclassSkip[];
}

/**
 * Every candidate lands in exactly one of the two lists. That identity is what
 * `propose_reclassification` reports to `buildEnvelope`, and it is checkable
 * only because nothing here filters silently.
 */
export function partitionCandidates(
  rows: readonly CandidateRow[],
  opts: PartitionOptions,
): Partitioned {
  const movable: ReclassCandidate[] = [];
  const skipped: ReclassSkip[] = [];

  for (const row of rows) {
    const reason = skipReasonFor(row, opts);
    if (reason !== null) {
      skipped.push({
        lineId: row.line_id,
        journalEntryId: row.journal_entry_id,
        entryNumber: row.entry_number,
        entryDate: row.entry_date,
        // The amount is the fact that tells a reader whether to care: "three
        // lines were skipped" and "R1.06m was skipped" are different findings.
        amount: num(row.debit) - num(row.credit),
        reason,
      });
      continue;
    }
    movable.push({
      lineId: row.line_id,
      journalEntryId: row.journal_entry_id,
      entryNumber: row.entry_number,
      entryDate: row.entry_date,
      debit: num(row.debit),
      credit: num(row.credit),
      description: row.description,
      projectId: row.project_id,
      costCenterId: row.cost_center_id,
    });
  }

  return { movable, skipped };
}

export interface CandidateQuery {
  sourceAccountId: string;
  /** Inclusive lower bound on the source entry date, or null for no bound. */
  from: string | null;
  /** Inclusive upper bound, or null. */
  to: string | null;
  /** Hard cap; the caller refuses above it rather than truncating silently. */
  limit: number;
}

/**
 * Every posted line currently sitting on the source account, with the state
 * each guard needs, read in ONE query.
 *
 * `is_active` is deliberately absent from every predicate here. It is a picker
 * flag — four production accounts hold R137,317.39 while inactive — and this
 * query is computing a figure, not populating a dropdown. Whether the SOURCE or
 * TARGET account may be posted to at all is a separate, request-level question
 * the tool answers before it calls this.
 *
 * `LIMIT limit + 1`: one row past the cap is how the caller tells "exactly at
 * the cap" from "more than the cap", without a second count.
 */
export async function findReclassCandidates(
  companyId: string,
  q: CandidateQuery,
): Promise<CandidateRow[]> {
  const rows = (await sql`
    SELECT jl.id                       AS line_id,
           jl.journal_entry_id,
           je.entry_number,
           je.entry_date,
           jl.debit,
           jl.credit,
           jl.description,
           jl.project_id,
           jl.cost_center_id,
           (je.reversed_at IS NOT NULL) AS reversed,
           fp.status                    AS period_status,
           (fp.id IS NOT NULL)          AS has_period,
           EXISTS (
             SELECT 1 FROM reclassification_batch_lines rbl
              JOIN gl_journal_entries rje
                ON rje.id = rbl.journal_entry_id AND rje.company_id = rbl.company_id
              WHERE rbl.company_id = jl.company_id
                AND rbl.source_line_id = jl.id
                -- A reversed reclassification did not stick, so its source line
                -- is movable again. Without this a corrected mistake would be
                -- permanently unfixable.
                AND rje.reversed_at IS NULL
           ) AS already_reclassified,
           EXISTS (
             SELECT 1 FROM reclassification_batch_lines rbl2
              JOIN reclassification_batches rb
                ON rb.id = rbl2.batch_id AND rb.company_id = rbl2.company_id
              WHERE rbl2.company_id = jl.company_id
                -- This line belongs to a reclassification journal AND sits on
                -- that batch's SOURCE account, so it is a contra leg. The
                -- TARGET leg of the same journal is not matched: an amount
                -- moved onto an account may legitimately be moved on again.
                AND rbl2.journal_entry_id = jl.journal_entry_id
                AND rb.source_account_id  = jl.gl_account_id
           ) AS is_reclass_contra,
           EXISTS (
             SELECT 1 FROM vat_period_locks vpl
              WHERE vpl.company_id = jl.company_id
                AND vpl.period_start <= je.entry_date
                AND vpl.period_end   >= je.entry_date
           ) AS vat_period_locked
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je
        ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
      LEFT JOIN fiscal_periods fp
        ON fp.id = je.fiscal_period_id AND fp.company_id = je.company_id
     WHERE jl.company_id      = ${companyId}::UUID
       AND jl.gl_account_id   = ${q.sourceAccountId}::UUID
       AND je.status          = 'posted'
       AND (${q.from}::DATE IS NULL OR je.entry_date >= ${q.from}::DATE)
       AND (${q.to}::DATE   IS NULL OR je.entry_date <= ${q.to}::DATE)
     ORDER BY je.entry_date, je.entry_number, jl.id
     LIMIT ${q.limit + 1}
  `) as DbRow[];

  return rows.map((r) => ({
    line_id: String(r.line_id),
    journal_entry_id: String(r.journal_entry_id),
    entry_number: r.entry_number === null ? null : String(r.entry_number),
    // pg returns a DATE as a string here (setTypeParser(1082), src/lib/pgTypes)
    // — but a Date would silently stringify to an ISO timestamp, so normalise.
    entry_date: r.entry_date instanceof Date
      ? r.entry_date.toISOString().slice(0, 10)
      : String(r.entry_date),
    debit: r.debit as string,
    credit: r.credit as string,
    description: r.description === null ? null : String(r.description),
    project_id: r.project_id === null ? null : String(r.project_id),
    cost_center_id: r.cost_center_id === null ? null : String(r.cost_center_id),
    reversed: r.reversed === true,
    period_status: r.period_status === null ? null : String(r.period_status),
    has_period: r.has_period === true,
    already_reclassified: r.already_reclassified === true,
    is_reclass_contra: r.is_reclass_contra === true,
    vat_period_locked: r.vat_period_locked === true,
  }));
}

/** Candidate lines on the source account, before any guard — the universe. */
export async function countReclassCandidates(
  companyId: string,
  q: Omit<CandidateQuery, 'limit'>,
): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::INT AS n
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je
        ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
     WHERE jl.company_id    = ${companyId}::UUID
       AND jl.gl_account_id = ${q.sourceAccountId}::UUID
       AND je.status        = 'posted'
       AND (${q.from}::DATE IS NULL OR je.entry_date >= ${q.from}::DATE)
       AND (${q.to}::DATE   IS NULL OR je.entry_date <= ${q.to}::DATE)
  `) as DbRow[];
  return Number(rows[0]?.n ?? 0);
}
