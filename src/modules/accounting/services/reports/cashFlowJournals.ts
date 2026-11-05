/**
 * The journals a cash flow statement is made of, as both methods read them: per posted journal, its net movement on the
 * cash accounts and its non-cash legs (one per account kind), each classified by the one classification in
 * `cashFlowIndirectClassification`. The indirect and the direct statement place the same journals the same way, so their
 * operating / investing / financing totals agree by construction.
 *
 * Every query is scoped to `companyId`.
 */

import { sql } from '@/lib/neon';
import { toMoney } from '@/lib/money/decimalSum';
import { CASH_SUBTYPES, type AccountType } from '@/modules/accounting/services/gl/accountSubtypes';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import { isDisposalJournal, SEEDED_CURRENT_PORTION_CODE, type JournalLeg } from './cashFlowIndirectClassification';

interface MovementRow {
  journal_entry_id: string; source: string | null; net_cash: string | number | null; account_type: AccountType; account_subtype: string | null;
  is_loan_current_portion: boolean; debit: string | number | null; credit: string | number | null;
}

export interface CashFlowJournal {
  /** Debit less credit on the journal's cash accounts. */
  netCash: number;
  /** Whether the asset-disposal rules apply (`isDisposalJournal`). */
  disposal: boolean;
  legs: JournalLeg[];
}

export interface JournalFetchOptions {
  /** The indirect statement ignores the year-end closing journal (both legs); the direct one keeps its cash legs. */
  includeYearEnd?: boolean;
  /** Only journals with a leg on a cash account (all the direct statement needs). */
  cashJournalsOnly?: boolean;
}

/**
 * Posted debits and credits of every non-cash account in the period, per journal and account kind, with the journal's
 * net movement on its cash accounts. An account is the current portion of debt when it is the seeded system account or a
 * loan of this company names it (`loans.current_portion_account_id`, what a repayment debits).
 */
async function fetchNonCashMovement(
  companyId: string, startDate: string, endDate: string, { includeYearEnd = false, cashJournalsOnly = false }: JournalFetchOptions,
): Promise<MovementRow[]> {
  return (await sql`
    WITH lines AS (
      SELECT ga.account_type, ga.account_subtype, jl.debit, jl.credit, jl.journal_entry_id, je.source,
             -- The cash accounts are what is being explained (the same predicate as cash.balance.v1).
             (ga.account_type = 'asset' AND COALESCE(ga.account_subtype = ANY(${CASH_SUBTYPES as string[]}), false)) AS is_cash,
             (ga.account_type = 'liability' AND (
               (ga.is_system_account AND ga.account_code = ${SEEDED_CURRENT_PORTION_CODE})
               OR EXISTS (SELECT 1 FROM loans ln WHERE ln.company_id = ${companyId}::UUID AND ln.current_portion_account_id = ga.id)
             )) AS is_loan_current_portion
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted' AND (${includeYearEnd}::boolean OR je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE})
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND ga.company_id = ${companyId}::UUID
        AND je.entry_date BETWEEN ${startDate} AND ${endDate}
    ), journal_cash AS (
      SELECT journal_entry_id, SUM(COALESCE(debit, 0) - COALESCE(credit, 0)) AS net_cash FROM lines WHERE is_cash GROUP BY journal_entry_id
    )
    SELECT l.journal_entry_id, l.source, COALESCE(jc.net_cash, 0)::numeric AS net_cash,
           l.account_type, l.account_subtype, l.is_loan_current_portion,
           COALESCE(SUM(l.debit), 0)::numeric  AS debit,
           COALESCE(SUM(l.credit), 0)::numeric AS credit
    FROM lines l
    LEFT JOIN journal_cash jc ON jc.journal_entry_id = l.journal_entry_id
    WHERE NOT l.is_cash AND (NOT ${cashJournalsOnly}::boolean OR l.journal_entry_id IN (SELECT journal_entry_id FROM lines WHERE is_cash))
    GROUP BY l.journal_entry_id, l.source, jc.net_cash, l.account_type, l.account_subtype, l.is_loan_current_portion
  `) as MovementRow[];
}

/** The period's posted journals, each with its cash movement and non-cash legs. */
export async function fetchCashFlowJournals(
  companyId: string, startDate: string, endDate: string, options: JournalFetchOptions = {},
): Promise<CashFlowJournal[]> {
  const rows = await fetchNonCashMovement(companyId, startDate, endDate, options);
  const byJournal = new Map<string, MovementRow[]>();
  for (const r of rows) byJournal.set(r.journal_entry_id, [...(byJournal.get(r.journal_entry_id) ?? []), r]);
  return [...byJournal.values()].map((legRows) => {
    const legs: JournalLeg[] = legRows.map((r) => ({
      accountType: r.account_type,
      subtype: r.account_subtype,
      isLoanCurrentPortion: r.is_loan_current_portion === true,
      creditLessDebit: toMoney(Number(r.credit ?? 0) - Number(r.debit ?? 0)),
    }));
    return { netCash: toMoney(Number(legRows[0]!.net_cash ?? 0)), disposal: isDisposalJournal(legRows[0]!.source, legs), legs };
  });
}
