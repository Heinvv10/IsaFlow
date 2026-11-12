/**
 * Revenue and profit month to date: the one definition the headline figures use
 * (reports/headlineFigures). Posted journals only, the year-end closing journal
 * left out, dated from the 1st of `asAt`'s month up to and including `asAt`
 * (nothing dated after `asAt` counts).
 *
 * Revenue is TURNOVER, as the income statement's Revenue line: the other-income
 * band (revenueBand) is left out. Profit counts every revenue-type account less
 * every expense, as the statement's net profit does.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { revenueBand } from '../gl/accountClassification';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';

export interface MtdIncome { revenueMtd: number; profitMtd: number }

const cents = (n: number): number => Math.round(n * 100) / 100;

/** `asAt` is the SAST app date (YYYY-MM-DD). */
export async function getMtdIncome(companyId: string, asAt: string): Promise<MtdIncome> {
  const monthStart = `${asAt.slice(0, 8)}01`;
  const rows = (await sql`
    SELECT ga.account_type, ga.account_subtype,
           COALESCE(SUM(jl.credit - jl.debit), 0) AS net_credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
     WHERE ga.account_type IN ('revenue', 'expense')
       AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
       AND je.company_id = ${companyId}::UUID AND jl.company_id = ${companyId}::UUID
       AND je.entry_date >= ${monthStart}::DATE AND je.entry_date <= ${asAt}::DATE
     GROUP BY ga.account_type, ga.account_subtype
  `) as DbRow[];

  let turnover = 0;
  let allRevenue = 0;
  let expenses = 0;
  for (const r of rows) {
    const net = Number(r.net_credit ?? 0);
    if (r.account_type === 'revenue') {
      allRevenue += net;
      if (revenueBand(r.account_subtype as string | null) === 'turnover') turnover += net;
    } else {
      expenses -= net;
    }
  }
  return { revenueMtd: cents(turnover), profitMtd: cents(allRevenue - expenses) };
}
