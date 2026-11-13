/**
 * The set of ledger lines a general-ledger read selects: `FROM … WHERE …` over `jl` (line), `je` (entry) and
 * `ga` (account) for a period and the account-level and line-level filters. The line stream's `matched` CTE and the
 * MCP `general_ledger` group_by summary (./generalLedgerSummaryService) both splice THIS fragment, so a group total can
 * not describe a different set from the page lines.
 *
 * Every filter is an array and an EMPTY array disables its clause (`cardinality(...) = 0 OR ...`): see the note on
 * getGeneralLedgerLines for why the SQL text is not branched per filter combination.
 */
import { sql } from '@/lib/neon';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import type { GeneralLedgerQuery } from './generalLedgerStreamTypes';

export function matchedLinesFromWhere(query: Omit<GeneralLedgerQuery, 'limit' | 'after'>) {
  const {
    companyId, periodStart, periodEnd,
    accountCodes = [], accountIds = [], accountTypes = [],
    sources = [], minAmount, search,
  } = query;
  const codes = [...accountCodes];
  const ids = [...accountIds];
  const types = [...accountTypes];
  const srcs = [...sources];
  // A null threshold disables the clause; 0 would admit every line and read as
  // "no filter" while still suppressing the running balance.
  const minAmt = minAmount ?? null;
  const term = search === undefined || search === '' ? null : `%${search}%`;
  return sql`
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
                                  AND je.company_id = ${companyId}::UUID
                                  AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
                           AND ga.company_id = ${companyId}::UUID
        WHERE jl.company_id = ${companyId}::UUID
          AND je.entry_date >= ${periodStart}::DATE
          AND je.entry_date <= ${periodEnd}::DATE
          AND (cardinality(${codes}::text[]) = 0 OR ga.account_code = ANY(${codes}::text[]))
          AND (cardinality(${ids}::uuid[])  = 0 OR ga.id            = ANY(${ids}::uuid[]))
          AND (cardinality(${types}::text[]) = 0 OR ga.account_type = ANY(${types}::text[]))
          AND (cardinality(${srcs}::text[])  = 0 OR COALESCE(je.source, 'manual') = ANY(${srcs}::text[]))
          AND (${minAmt}::NUMERIC IS NULL
               OR GREATEST(jl.debit, jl.credit) >= ${minAmt}::NUMERIC)
          AND (${term}::TEXT IS NULL
               OR je.entry_number ILIKE ${term}::TEXT
               OR COALESCE(je.description, '') ILIKE ${term}::TEXT)
      `;
}
