/**
 * What the ledger has already booked of a month's ETI (wave 5 ET, coordinator ruling H2 option a). A month's ETI used
 * (ETI Act s9(1)) and, in August and February, its refund (s10(1); Hein ruling R-C) are booked by whichever payroll
 * journals post in that month: the pay run's journal (netted into its 2140 credit and 5200 debit, K-079) and the ETI
 * journals a stand-alone directive payment posts (`directivePaymentEti`), each booking only what is not booked yet.
 *
 * Read from the ledger, so a reversal is counted as what it is:
 *  - ETI journals: reference `ETI-YYYY-MM`, source 'auto_payroll', and every journal reversing one of them (by
 *    reversal_of_id, to any depth). ETI used = their net debit on 2140; refund = their net debit on any account of the
 *    eti_refund_receivable subtype (migration 974).
 *  - The run's journal, while it is in force: ETI used = the run's PAYE - its net 2140 credit; refund = its net debit
 *    on the receivable.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { payrollJournalInForce } from './payrollJournalChain';
import type { YearMonth } from './etiCarry';

export interface EtiBooked { used: number; refund: number }
/** The run journal's booking, plus its net 2140 credit (nil when no journal of the month is in force). */
export interface RunBooked extends EtiBooked { net2140: number }

const pad = (n: number): string => String(n).padStart(2, '0');
export const etiJournalReference = (ym: YearMonth): string => `ETI-${ym.year}-${pad(ym.month)}`;
const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Booked by the month's ETI journals (and their reversals). */
export async function bookedByEtiJournals(companyId: string, ym: YearMonth): Promise<EtiBooked> {
  const rows = (await sql`
    WITH RECURSIVE chain(id, depth) AS (
      SELECT je.id, 0 FROM gl_journal_entries je
       WHERE je.company_id = ${companyId}::UUID AND je.source = 'auto_payroll' AND je.reference = ${etiJournalReference(ym)}
      UNION ALL
      SELECT r.id, c.depth + 1 FROM gl_journal_entries r JOIN chain c ON r.reversal_of_id = c.id
       WHERE r.company_id = ${companyId}::UUID AND c.depth < 16
    )
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_code = '2140' THEN jl.debit - jl.credit ELSE 0 END), 0) AS used,
      COALESCE(SUM(CASE WHEN ga.account_subtype = 'eti_refund_receivable' THEN jl.debit - jl.credit ELSE 0 END), 0) AS refund
      FROM chain
      JOIN gl_journal_entries je ON je.id = chain.id AND je.company_id = ${companyId}::UUID AND je.status = 'posted'
      JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = je.company_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = je.company_id
  `) as DbRow[];
  return { used: r2(Number(rows[0]?.used) || 0), refund: r2(Number(rows[0]?.refund) || 0) };
}

/** Booked by the month's pay-run journal, while it is in force. */
export async function bookedByRunJournal(companyId: string, ym: YearMonth): Promise<RunBooked> {
  const header = ((await sql`
    SELECT journal_entry_id, total_paye FROM payroll_run_headers
     WHERE company_id = ${companyId}::UUID AND period_year = ${ym.year} AND period_month = ${ym.month}
       AND journal_entry_id IS NOT NULL
  `) as DbRow[])[0];
  if (!header || header.journal_entry_id == null || !(await payrollJournalInForce(companyId, String(header.journal_entry_id)))) {
    return { used: 0, refund: 0, net2140: 0 };
  }
  const rows = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_code = '2140' THEN jl.credit - jl.debit ELSE 0 END), 0) AS paye_net,
      COALESCE(SUM(CASE WHEN ga.account_subtype = 'eti_refund_receivable' THEN jl.debit - jl.credit ELSE 0 END), 0) AS refund
      FROM gl_journal_lines jl
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
     WHERE jl.company_id = ${companyId}::UUID AND jl.journal_entry_id = ${String(header.journal_entry_id)}::UUID
  `) as DbRow[];
  return {
    used: r2((Number(header.total_paye) || 0) - (Number(rows[0]?.paye_net) || 0)),
    refund: r2(Number(rows[0]?.refund) || 0),
    net2140: r2(Number(rows[0]?.paye_net) || 0),
  };
}
