/**
 * Reading the candidate lines a reclassification could move.
 *
 * Queries only. The DECISION — which of them may actually move, and why each of
 * the rest may not — is pure and lives in ./partition.ts, so that the dry run
 * and the live call reach the same verdict from the same read.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { CandidateRow } from './partition';

export type {
  CandidateRow, ReclassCandidate, ReclassSkip, ReclassSkipReason,
  PartitionOptions, Partitioned,
} from './partition';
export { partitionCandidates } from './partition';

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
           jl.vat_type,
           jl.bu_id,
           jl.cc1_id,
           jl.cc2_id,
           (je.reversed_at IS NOT NULL)   AS reversed,
           (je.reversal_of_id IS NOT NULL) AS is_reversal_leg,
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
    vat_type: r.vat_type === null || r.vat_type === undefined ? null : String(r.vat_type),
    bu_id: r.bu_id === null || r.bu_id === undefined ? null : String(r.bu_id),
    cc1_id: r.cc1_id === null || r.cc1_id === undefined ? null : String(r.cc1_id),
    cc2_id: r.cc2_id === null || r.cc2_id === undefined ? null : String(r.cc2_id),
    reversed: r.reversed === true,
    is_reversal_leg: r.is_reversal_leg === true,
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
