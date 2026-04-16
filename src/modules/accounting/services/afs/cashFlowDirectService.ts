import { sql } from '@/lib/neon';
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

async function fetchOpeningCash(companyId: string, beforeDate: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(
      CASE WHEN ga.normal_balance = 'debit'
        THEN jl.debit - jl.credit
        ELSE jl.credit - jl.debit END
    ), 0)::numeric AS balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga         ON ga.id = jl.gl_account_id
    WHERE ga.account_subtype = 'bank'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status     = 'posted'
      AND je.entry_date < ${beforeDate}
  `) as Row[];
  return Number(rows[0]?.balance ?? 0);
}

async function fetchGroupedAllocations(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Array<{ cashGroup: string; amount: number }>> {
  const rows = (await sql`
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
    JOIN gl_journal_lines jl_bank ON jl_bank.bank_transaction_id = bt.id
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

  return rows.map(r => ({
    cashGroup: String(r.cash_group),
    amount:    Number(r.amount),
  }));
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
