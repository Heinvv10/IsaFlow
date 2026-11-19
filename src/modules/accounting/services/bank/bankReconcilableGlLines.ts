/**
 * The GL side of a reconciliation: the bank account's journal lines a statement line may still be matched to.
 *
 * ONE definition (`reconcilableGlLineWhere`), used by auto-match (`autoMatchTransactions`) and by the reconciliation
 * screen's manual-match list (`listReconcilableGlLines`, GET /api/accounting/bank-reconciliation-gl-lines), so the
 * list offers exactly the lines auto-match considers. The screen used to read them from the journal-entries list,
 * which ignores `gl_account_id`, carries no lines and stops at the 200 newest entries: its GL list was empty.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { journalStandsUnbrokenFragment } from '../shared/journalInForceAsAt';
import { provisionallyHeldJournalIds } from './bankProvisionalHeldJournals';
import type { DbRow } from '@/types/db';

/** Most lines one list call returns; `total` says how many match, so a longer list is never shown as the whole. */
export const RECON_GL_LINES_MAX = 500;
export const RECON_GL_SEARCH_MAX = 100;

/**
 * The WHERE predicate over `gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id` (each caller
 * writes that FROM, and its own company_id scope, in its own statement, so the ledger censuses (BL-13, G-01) still
 * read them there; the predicate scopes by company as well): this company's POSTED lines on the bank account,
 * on a journal that stands (not reversed out of the ledger) and that no bank-first provisional holds
 * (bankProvisionalHeldJournals), not already matched to any statement line, and, inside a
 * session, dated on or before its statement date while it is in progress (a missing or completed session makes the
 * date NULL, so nothing qualifies: fail closed). `sessionId` null = no session (auto-match without one).
 */
export function reconcilableGlLineWhere(companyId: string, bankAccountId: string, sessionId: string | null) {
  return sql`
      jl.gl_account_id = ${bankAccountId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND je.status = 'posted' AND je.company_id = ${companyId}::UUID
        -- D11 round 5: only journals that STAND (not reversed out of the ledger): matchTransaction refuses a line on a
        -- reversed chain, which answered 400 with the earlier matches committed behind it.
        AND ${journalStandsUnbrokenFragment('je.id', companyId)}
        -- A bank-first provisional's journal (down its reversal chain) is held by its own statement line:
        -- matchTransaction refuses a second line on it (LINE_CLAIMED), so it is never a candidate.
        AND jl.journal_entry_id NOT IN (${provisionallyHeldJournalIds(companyId)})
        -- company_id on the subquery: unscoped it read every tenant's rows.
        AND jl.id NOT IN (
          SELECT matched_journal_line_id FROM bank_transactions
          WHERE matched_journal_line_id IS NOT NULL
            AND company_id = ${companyId}::UUID)
        AND (${sessionId}::UUID IS NULL OR je.entry_date <= (SELECT r.statement_date
          FROM bank_reconciliations r
          WHERE r.id = ${sessionId}::UUID AND r.company_id = ${companyId}::UUID AND r.status = 'in_progress'))`;
}

export interface ReconGlLine {
  id: string;
  debit: number;
  credit: number;
  description: string;
  entryDate: string;
  entryNumber: string;
}

export interface ReconGlLinesPage {
  lines: ReconGlLine[];
  /** How many lines match (the search included); more than `lines.length` when the list was cut at `limit`. */
  total: number;
  truncated: boolean;
}

/** A LIKE pattern that matches `text` literally anywhere (its %, _ and \ escaped). */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * The manual-match list for session `reconciliationId`, newest first: every reconcilable line of its bank account
 * (the auto-match definition above), optionally narrowed by `search` (line or journal description, entry number, or
 * the amount as typed, e.g. 1234.50). Null when the session is not this company's.
 */
export async function listReconcilableGlLines(
  companyId: string, reconciliationId: string, opts: { search?: string; limit?: number } = {},
): Promise<ReconGlLinesPage | null> {
  const [session] = (await sql`
    SELECT bank_account_id FROM bank_reconciliations
    WHERE id = ${reconciliationId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  if (!session) return null;
  const limit = Math.min(Math.max(1, opts.limit ?? RECON_GL_LINES_MAX), RECON_GL_LINES_MAX);
  const search = opts.search?.trim() ? containsPattern(opts.search.trim()) : null;
  const rows = (await sql`
    SELECT jl.id, jl.debit, jl.credit, COALESCE(NULLIF(jl.description, ''), je.description, '') AS description,
      je.entry_date, je.entry_number, COUNT(*) OVER () AS total
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE jl.company_id = ${companyId}::UUID AND je.company_id = ${companyId}::UUID
      AND ${reconcilableGlLineWhere(companyId, String(session.bank_account_id), reconciliationId)}
      AND (${search}::TEXT IS NULL
        OR jl.description ILIKE ${search}::TEXT
        OR je.description ILIKE ${search}::TEXT
        OR je.entry_number ILIKE ${search}::TEXT
        OR ABS(jl.debit - jl.credit)::TEXT LIKE ${search}::TEXT)
    ORDER BY je.entry_date DESC, je.entry_number DESC NULLS LAST, jl.id
    LIMIT ${limit}`) as DbRow[];
  const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
  return {
    lines: rows.map((r) => ({
      id: String(r.id), debit: Number(r.debit), credit: Number(r.credit), description: String(r.description ?? ''),
      entryDate: fmtDate(r.entry_date), entryNumber: r.entry_number ? String(r.entry_number) : '',
    })),
    total,
    truncated: total > rows.length,
  };
}
