/**
 * The general-ledger stream's UNIVERSE: the unfiltered posted line count of the window.
 *
 * The stream's main query carries `universe_count` on every row it returns, so a call whose filters match NO line has
 * no row to read it from. Reporting 0 there said "this window is empty and nothing was excluded" about a window that
 * held lines (general_ledger with a `search` that hits nothing in a narrow window). This reads it on its own.
 *
 * It MUST stay the same predicate as the `universe` CTE in generalLedgerStreamService (company, posted, not the
 * year-end close journal, entry_date inside the window): the integration suite mcp-general-ledger-universe pins the two
 * to each other by requiring the empty-match answer to equal the matched-rows answer.
 */
import { sql, type DbRow } from '@/lib/neon';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';

export async function readUniverseLineCount(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*) AS universe_count
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
                              AND je.company_id = ${companyId}::UUID
                              AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
    WHERE jl.company_id = ${companyId}::UUID
      AND je.entry_date >= ${periodStart}::DATE
      AND je.entry_date <= ${periodEnd}::DATE
  `) as DbRow[];
  return Number(rows[0]?.universe_count ?? 0);
}
