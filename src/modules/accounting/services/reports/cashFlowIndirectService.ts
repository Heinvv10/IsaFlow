/**
 * The indirect-method cash flow statement of the Reports screen and its CSV export, from the general ledger.
 *
 * Opening cash is `cash.balance.v1` the day before the period; the period's movement is the credit-less-debit of every
 * posted NON-cash journal line in it, each classified once (`placeJournal`: only the cash a journal actually moved shows
 * as an investing or financing flow). Because a journal balances, that
 * sum IS the change in cash, so closing cash equals the ledger's cash balance by construction (and a test holds it),
 * whatever the books carry. The year-end closing journal is ignored, both legs, as every statement does.
 *
 * Every query is scoped to `companyId`.
 */

import { sql } from '@/lib/neon';
import { toMoney } from '@/lib/money/decimalSum';
import { CASH_SUBTYPES, type AccountType } from '@/modules/accounting/services/gl/accountSubtypes';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import {
  bucketSection, INDIRECT_BUCKETS, placeJournal, SEEDED_CURRENT_PORTION_CODE, type IndirectBucket, type IndirectSection,
} from './cashFlowIndirectClassification';

export interface IndirectCashFlowItem { label: string; amount: number }
export interface IndirectCashFlowSection { section: string; items: IndirectCashFlowItem[]; total: number }
export interface IndirectCashFlow {
  periodStart: string;
  periodEnd: string;
  openingCash: number;
  sections: IndirectCashFlowSection[];
  netChange: number;
  closingCash: number;
}

interface MovementRow {
  journal_entry_id: string; net_cash: string | number | null; account_type: AccountType; account_subtype: string | null;
  is_loan_current_portion: boolean; debit: string | number | null; credit: string | number | null;
}

/** Label per line; `always` lines show at zero (the screen's long-standing layout), the others only when they moved. */
const LINES: Record<IndirectBucket, { label: string; always: boolean }> = {
  net_income: { label: 'Net Income', always: true },
  receivable: { label: 'Change in Accounts Receivable', always: true },
  payable: { label: 'Change in Accounts Payable', always: true },
  depreciation: { label: 'Depreciation and Amortisation (non-cash)', always: false },
  inventory: { label: 'Change in Inventory', always: false },
  vat: { label: 'Change in VAT Control', always: false },
  other_operating: { label: 'Change in Other Operating Assets and Liabilities', always: false },
  non_cash: { label: 'Non-cash Investing and Financing Items', always: false },
  investing: { label: 'Fixed Asset Changes', always: true },
  equity: { label: 'Equity Changes', always: true },
  debt: { label: 'Change in Loans and Borrowings', always: false },
  retained_earnings: { label: 'Retained Earnings Movements (other than the year-end close)', always: false },
};

const SECTIONS: Array<{ key: IndirectSection; title: string }> = [
  { key: 'operating', title: 'Operating Activities' },
  { key: 'investing', title: 'Investing Activities' },
  { key: 'financing', title: 'Financing Activities' },
];

/**
 * Posted debits and credits of every non-cash account in the period, per journal and account kind, with the journal's
 * net movement on its cash accounts. An account is the current portion of debt when it is the seeded system account or a
 * loan of this company names it (`loans.current_portion_account_id`, what a repayment debits).
 */
async function fetchNonCashMovement(companyId: string, startDate: string, endDate: string): Promise<MovementRow[]> {
  return (await sql`
    WITH lines AS (
      SELECT ga.account_type, ga.account_subtype, jl.debit, jl.credit, jl.journal_entry_id,
             -- The cash accounts are what is being explained (the same predicate as cash.balance.v1).
             (ga.account_type = 'asset' AND COALESCE(ga.account_subtype = ANY(${CASH_SUBTYPES as string[]}), false)) AS is_cash,
             (ga.account_type = 'liability' AND (
               (ga.is_system_account AND ga.account_code = ${SEEDED_CURRENT_PORTION_CODE})
               OR EXISTS (SELECT 1 FROM loans ln WHERE ln.company_id = ${companyId}::UUID AND ln.current_portion_account_id = ga.id)
             )) AS is_loan_current_portion
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND ga.company_id = ${companyId}::UUID
        AND je.entry_date BETWEEN ${startDate} AND ${endDate}
    ), journal_cash AS (
      SELECT journal_entry_id, SUM(COALESCE(debit, 0) - COALESCE(credit, 0)) AS net_cash FROM lines WHERE is_cash GROUP BY journal_entry_id
    )
    SELECT l.journal_entry_id, COALESCE(jc.net_cash, 0)::numeric AS net_cash,
           l.account_type, l.account_subtype, l.is_loan_current_portion,
           COALESCE(SUM(l.debit), 0)::numeric  AS debit,
           COALESCE(SUM(l.credit), 0)::numeric AS credit
    FROM lines l
    LEFT JOIN journal_cash jc ON jc.journal_entry_id = l.journal_entry_id
    WHERE NOT l.is_cash
    GROUP BY l.journal_entry_id, jc.net_cash, l.account_type, l.account_subtype, l.is_loan_current_portion
  `) as MovementRow[];
}

export async function getIndirectCashFlow(companyId: string, startDate: string, endDate: string): Promise<IndirectCashFlow> {
  const [openingCash, rows] = await Promise.all([
    getCashBalance(companyId, startDate, { exclusive: true }).then((b) => b.total),
    fetchNonCashMovement(companyId, startDate, endDate),
  ]);

  const byBucket = new Map<IndirectBucket, number>(INDIRECT_BUCKETS.map((b) => [b, 0]));
  const journals = new Map<string, MovementRow[]>();
  for (const r of rows) journals.set(r.journal_entry_id, [...(journals.get(r.journal_entry_id) ?? []), r]);
  for (const legs of journals.values()) {
    const placed = placeJournal(legs.map((r) => ({
      accountType: r.account_type,
      subtype: r.account_subtype,
      isLoanCurrentPortion: r.is_loan_current_portion === true,
      creditLessDebit: toMoney(Number(r.credit ?? 0) - Number(r.debit ?? 0)),
    })), toMoney(Number(legs[0]!.net_cash ?? 0)));
    for (const { bucket, amount } of placed) byBucket.set(bucket, byBucket.get(bucket)! + amount);
  }

  const sections: IndirectCashFlowSection[] = SECTIONS.map(({ key, title }) => {
    const items = INDIRECT_BUCKETS
      .filter((b) => bucketSection(b) === key)
      .map((b) => ({ bucket: b, amount: toMoney(byBucket.get(b)!) }))
      .filter((i) => LINES[i.bucket].always || i.amount !== 0)
      .map((i) => ({ label: LINES[i.bucket].label, amount: i.amount }));
    return { section: title, items, total: toMoney(items.reduce((s, i) => s + i.amount, 0)) };
  });

  const netChange = toMoney(sections.reduce((s, x) => s + x.total, 0));
  return { periodStart: startDate, periodEnd: endDate, openingCash, sections, netChange, closingCash: toMoney(openingCash + netChange) };
}
