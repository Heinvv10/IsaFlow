import { sql } from '@/lib/neon';
import { getCashBalance } from '../bank/cashBalanceService';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface DirectCashFlowItem {
  cashGroup: string;
  label: string;
  amount: number;
}

export interface CashFlowDirectReport {
  periodStart: string;
  periodEnd: string;
  openingCash: number;
  operatingItems: DirectCashFlowItem[];
  operatingTotal: number;
  investingItems: DirectCashFlowItem[];
  investingTotal: number;
  financingItems: DirectCashFlowItem[];
  financingTotal: number;
  netChange: number;
  closingCash: number;
}

const CASH_GROUP_LABELS: Record<string, string> = {
  cash_received_from_customers: 'Cash received from customers',
  cash_paid_to_suppliers:       'Cash paid to suppliers',
  cash_paid_to_employees:       'Cash paid to employees',
  other_operating:              'Other operating cash flows',
  investing:                    'Net investing cash flows',
  financing:                    'Net financing cash flows',
};

const OPERATING_GROUPS = new Set([
  'cash_received_from_customers',
  'cash_paid_to_suppliers',
  'cash_paid_to_employees',
  'other_operating',
]);

/**
 * Opening cash — `cash.balance.v1`, from its owning service.
 *
 * This function used to carry its own copy of the query. It had the right basis
 * (posted GL movement on bank-subtype accounts) and kept it private, so the
 * dashboard and the balance sheet each grew their own and cash ended up with
 * four answers. It is exclusive on the date because an opening balance is the
 * closing balance of the day before the period starts.
 */
async function fetchOpeningCash(companyId: string, beforeDate: string): Promise<number> {
  const cash = await getCashBalance(companyId, beforeDate, { exclusive: true });
  return cash.total;
}

async function fetchGroupedAllocations(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Array<{ cashGroup: string; amount: number }>> {
  // Primary source: bank transactions that have been matched to a journal line.
  // The contra-account (the non-bank leg) determines the cash-flow category.
  const matchedRows = (await sql`
    SELECT
      CASE
        WHEN ga.account_subtype IN ('revenue', 'receivable')          THEN 'cash_received_from_customers'
        WHEN ga.account_subtype IN ('payroll')                        THEN 'cash_paid_to_employees'
        WHEN ga.account_subtype IN ('expense', 'payable', 'cost_of_sales') THEN 'cash_paid_to_suppliers'
        WHEN ga.account_subtype IN ('fixed_asset', 'other_asset')    THEN 'investing'
        WHEN ga.account_type IN ('equity') OR ga.account_subtype IN ('loan') THEN 'financing'
        ELSE 'other_operating'
      END AS cash_group,
      COALESCE(SUM(
        CASE WHEN ga_bank.normal_balance = 'debit'
          THEN jl_bank.debit - jl_bank.credit
          ELSE jl_bank.credit - jl_bank.debit END
      ), 0)::numeric AS amount
    FROM bank_transactions bt
    JOIN gl_journal_lines jl_bank ON jl_bank.id = bt.matched_journal_line_id
    JOIN gl_accounts ga_bank      ON ga_bank.id = jl_bank.gl_account_id
      AND ga_bank.account_subtype = 'bank'
    JOIN gl_journal_lines jl ON jl.journal_entry_id = jl_bank.journal_entry_id
      AND jl.id != jl_bank.id
    JOIN gl_accounts ga       ON ga.id = jl.gl_account_id
    JOIN gl_journal_entries je ON je.id = jl_bank.journal_entry_id
    WHERE je.status     = 'posted'
      AND bt.company_id = ${companyId}::UUID
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND jl_bank.company_id = ${companyId}::UUID
      AND ga_bank.company_id = ${companyId}::UUID
      AND je.entry_date >= ${periodStart}
      AND je.entry_date <= ${periodEnd}
    GROUP BY cash_group
  `) as Row[];

  // Secondary source: posted bank-account journal lines with NO matching bank_transaction
  // (e.g. manual journals, opening-balance entries, year-end postings).  These are
  // classified as 'other_operating' since there is no contra-account metadata to
  // determine a more specific category.  Without this, direct closing cash diverges
  // from the GL bank balance by the sum of all unmatched bank-line movements.
  const unmatchedRows = (await sql`
    SELECT
      'other_operating' AS cash_group,
      COALESCE(SUM(
        CASE WHEN ga.normal_balance = 'debit'
          THEN jl.debit - jl.credit
          ELSE jl.credit - jl.debit END
      ), 0)::numeric AS amount
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga         ON ga.id = jl.gl_account_id
    WHERE ga.account_subtype = 'bank'
      AND je.status     = 'posted'
      AND jl.company_id = ${companyId}::UUID
      AND je.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.entry_date >= ${periodStart}
      AND je.entry_date <= ${periodEnd}
      AND NOT EXISTS (
        SELECT 1 FROM bank_transactions bt
        WHERE bt.matched_journal_line_id = jl.id
          AND bt.company_id = ${companyId}::UUID
      )
    GROUP BY cash_group
  `) as Row[];

  // Merge: add the unmatched amount into the 'other_operating' bucket.
  const combined = [...matchedRows, ...unmatchedRows];
  const merged = new Map<string, number>();
  for (const r of combined) {
    const group = String(r.cash_group);
    merged.set(group, (merged.get(group) ?? 0) + Number(r.amount));
  }

  return Array.from(merged.entries()).map(([cashGroup, amount]) => ({ cashGroup, amount }));
}

export async function getCashFlowDirect(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<CashFlowDirectReport> {
  try {
    const [openingCash, groupedRows] = await Promise.all([
      fetchOpeningCash(companyId, periodStart),
      fetchGroupedAllocations(companyId, periodStart, periodEnd),
    ]);

    const amountByGroup = new Map<string, number>(groupedRows.map(r => [r.cashGroup, r.amount]));

    const toItem = (group: string): DirectCashFlowItem => ({
      cashGroup: group,
      label:     CASH_GROUP_LABELS[group] ?? group,
      amount:    amountByGroup.get(group) ?? 0,
    });

    const operatingGroups = [
      'cash_received_from_customers',
      'cash_paid_to_suppliers',
      'cash_paid_to_employees',
      'other_operating',
    ];

    const extraOperating = groupedRows
      .filter(r => OPERATING_GROUPS.has(r.cashGroup) && !operatingGroups.includes(r.cashGroup))
      .map(r => r.cashGroup);

    const operatingItems = [...operatingGroups, ...extraOperating]
      .map(toItem)
      .filter(i => i.amount !== 0);

    const investingItems = groupedRows.filter(r => r.cashGroup === 'investing').map(r => toItem(r.cashGroup));
    const financingItems = groupedRows.filter(r => r.cashGroup === 'financing').map(r => toItem(r.cashGroup));

    const operatingTotal = operatingItems.reduce((s, i) => s + i.amount, 0);
    const investingTotal = investingItems.reduce((s, i) => s + i.amount, 0);
    const financingTotal = financingItems.reduce((s, i) => s + i.amount, 0);
    const netChange = operatingTotal + investingTotal + financingTotal;

    return {
      periodStart,
      periodEnd,
      openingCash,
      operatingItems,
      operatingTotal,
      investingItems,
      investingTotal,
      financingItems,
      financingTotal,
      netChange,
      closingCash: openingCash + netChange,
    };
  } catch (err) {
    log.error('Failed to generate direct cash flow', { error: err }, 'accounting');
    throw err;
  }
}
