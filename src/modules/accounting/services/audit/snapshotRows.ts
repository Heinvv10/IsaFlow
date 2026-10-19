/**
 * What a snapshot freezes, read from the live books at an accounting-date
 * cutoff: every POSTED journal and line dated on or before it (a reversed
 * journal stays 'posted' with reversed_at set, so it is in), and the trial
 * balance those lines make.
 *
 * Every value is spelled by the database — ids and dates as text, amounts as
 * numeric::text rounded to two places, timestamps as UTC with microseconds —
 * so the same row reads the same way at take time, on verification and in a
 * later comparison. Used for the snapshot AND for "today's books" in a
 * comparison: one definition of a row.
 */
import { sql } from '@/lib/neon';
import { materialHash } from './canonical';

export type CanonicalRow = Record<string, string | null>;

/**
 * Runs `fn` with nested-loop joins off, then puts the setting back. These are set-wise reads of a company's whole
 * ledger; with the statistics a fresh bulk load leaves (a few rows estimated, tens of thousands present) the planner
 * otherwise nests a 12 500-row index scan inside a 50 000-row one: 71 s instead of 57 ms, measured on a fixture.
 * The check run uses it too (master's vat_displayed_differs_from_posted hit the 60 s statement cap the same way).
 */
export async function bulkPlan<T>(fn: () => Promise<T>): Promise<T> {
  const [prev] = (await sql`SELECT current_setting('enable_nestloop') AS v`) as { v: string }[];
  await sql`SELECT set_config('enable_nestloop', 'off', true)`;
  // Restored only on success: after a failed statement the transaction is aborted, a restore would throw 25P02 over
  // the real error, and the local setting dies with the rollback anyway.
  const out = await fn();
  await sql`SELECT set_config('enable_nestloop', ${prev!.v}, true)`;
  return out;
}
export interface JournalRow { journalId: string; entryDate: string; row: CanonicalRow; materialHash: string }
export interface LineRow { lineId: string; journalId: string; row: CanonicalRow; materialHash: string }
export interface TbRow { accountId: string; row: CanonicalRow }

/** The first day of the fiscal year the cutoff falls in; 1 January when no fiscal period covers it. */
export async function fiscalYearStart(companyId: string, cutoff: string): Promise<string> {
  const [r] = (await sql`
    SELECT COALESCE(
      (SELECT min(fy.start_date) FROM fiscal_periods p
         JOIN fiscal_periods fy ON fy.company_id = p.company_id AND fy.fiscal_year = p.fiscal_year
        WHERE p.company_id = ${companyId}::UUID AND ${cutoff}::DATE BETWEEN p.start_date AND p.end_date),
      date_trunc('year', ${cutoff}::DATE)::DATE)::TEXT AS start
  `) as { start: string }[];
  return r!.start;
}

export async function countPostedLines(companyId: string, cutoff: string): Promise<number> {
  return bulkPlan(async () => {
    const [r] = (await sql`
      SELECT count(*)::INT AS n FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
      WHERE je.company_id = ${companyId}::UUID AND je.status = 'posted' AND je.entry_date <= ${cutoff}::DATE
    `) as { n: number }[];
    return r!.n;
  });
}

export async function journalRows(companyId: string, cutoff: string): Promise<JournalRow[]> {
  return bulkPlan(async () => {
    const rows = (await sql`
      SELECT je.id::TEXT AS id, je.entry_date::TEXT AS d, jsonb_build_object(
        'id', je.id::TEXT, 'entry_number', je.entry_number, 'entry_date', je.entry_date::TEXT,
        'fiscal_period_id', je.fiscal_period_id::TEXT, 'source', je.source, 'status', je.status,
        'description', je.description, 'reference', je.reference,
        'source_document_id', je.source_document_id::TEXT, 'source_document_hash', je.source_document_hash,
        'source_record_id', je.source_record_id::TEXT, 'project_id', je.project_id::TEXT,
        'created_by', je.created_by::TEXT, 'created_at', to_char(je.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'posted_by', je.posted_by::TEXT, 'posted_at', to_char(je.posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'reversed_by', je.reversed_by::TEXT, 'reversed_at', to_char(je.reversed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'reversal_of_id', je.reversal_of_id::TEXT, 'actor_type', je.actor_type, 'posting_agent', je.posting_agent,
        'is_intercompany', je.is_intercompany::TEXT, 'intercompany_company_id', je.intercompany_company_id::TEXT,
        'acting_company_id', je.acting_company_id::TEXT, 'external_ref', je.external_ref,
        'external_document_number', je.external_document_number, 'external_system', je.external_system,
        'needs_evidence', je.needs_evidence::TEXT,
        'evidenced_at', to_char(je.evidenced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'late_claim_of_id', je.late_claim_of_id::TEXT, 'approval_document_type', je.approval_document_type,
        'actor_token_jti', je.actor_token_jti, 'content_authors', je.content_authors::TEXT
      ) AS row
      FROM gl_journal_entries je
      WHERE je.company_id = ${companyId}::UUID AND je.status = 'posted' AND je.entry_date <= ${cutoff}::DATE
      ORDER BY je.id
    `) as { id: string; d: string; row: CanonicalRow }[];
    return rows.map((r) => ({ journalId: r.id, entryDate: r.d, row: r.row, materialHash: materialHash(r.row) }));
  });
}

export async function lineRows(companyId: string, cutoff: string): Promise<LineRow[]> {
  return bulkPlan(async () => {
    const rows = (await sql`
      SELECT jl.id::TEXT AS id, jl.journal_entry_id::TEXT AS j, jsonb_build_object(
        'id', jl.id::TEXT, 'journal_id', jl.journal_entry_id::TEXT, 'account_id', jl.gl_account_id::TEXT,
        'debit', round(COALESCE(jl.debit, 0), 2)::TEXT, 'credit', round(COALESCE(jl.credit, 0), 2)::TEXT,
        'description', jl.description, 'vat_type', jl.vat_type, 'cc1_id', jl.cc1_id::TEXT, 'cc2_id', jl.cc2_id::TEXT,
        'bu_id', jl.bu_id::TEXT, 'project_id', jl.project_id::TEXT,
        'source_document_line_id', jl.source_document_line_id::TEXT,
        'late_claim_base', round(jl.late_claim_base, 2)::TEXT
      ) AS row
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
      WHERE je.company_id = ${companyId}::UUID AND je.status = 'posted' AND je.entry_date <= ${cutoff}::DATE
      ORDER BY jl.id
    `) as { id: string; j: string; row: CanonicalRow }[];
    return rows.map((r) => ({ lineId: r.id, journalId: r.j, row: r.row, materialHash: materialHash(r.row) }));
  });
}

/**
 * A ledger trial balance per account up to the cutoff, from the same posted
 * lines the snapshot freezes: opening = net before the fiscal year's start,
 * debit / credit = the year's movement to the cutoff, closing = opening +
 * debit − credit (debit positive). Income-statement accounts are not reset at
 * year start here: what a year-end close posted is in the lines themselves.
 * RAW by design (G-01): unlike the trial_balance report, the posted year-end close is NOT skipped,
 * so this is the stored ledger an auditor can re-add, not the statement figure.
 */
export async function tbRows(companyId: string, cutoff: string, fyStart: string): Promise<TbRow[]> {
  return bulkPlan(async () => {
    const rows = (await sql`
      WITH m AS (
        SELECT jl.gl_account_id AS account_id,
               round(COALESCE(sum(CASE WHEN je.entry_date < ${fyStart}::DATE THEN COALESCE(jl.debit, 0) - COALESCE(jl.credit, 0) END), 0), 2) AS opening,
               round(COALESCE(sum(CASE WHEN je.entry_date >= ${fyStart}::DATE THEN COALESCE(jl.debit, 0) END), 0), 2) AS debit,
               round(COALESCE(sum(CASE WHEN je.entry_date >= ${fyStart}::DATE THEN COALESCE(jl.credit, 0) END), 0), 2) AS credit
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
        WHERE je.company_id = ${companyId}::UUID AND je.status = 'posted' AND je.entry_date <= ${cutoff}::DATE
        GROUP BY jl.gl_account_id
      )
      SELECT m.account_id::TEXT AS id, jsonb_build_object(
        'account_id', m.account_id::TEXT, 'account_code', ga.account_code, 'account_name', ga.account_name,
        'account_type', ga.account_type, 'opening', m.opening::TEXT, 'debit', m.debit::TEXT, 'credit', m.credit::TEXT,
        'closing', round(m.opening + m.debit - m.credit, 2)::TEXT
      ) AS row
      FROM m LEFT JOIN gl_accounts ga ON ga.id = m.account_id AND ga.company_id = ${companyId}::UUID
      ORDER BY m.account_id
    `) as { id: string; row: CanonicalRow }[];
    return rows.map((r) => ({ accountId: r.id, row: r.row }));
  });
}
