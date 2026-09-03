import { sql } from '@/lib/neon';
import { getCashBalance } from '../bank/cashBalanceService';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { CASH_SUBTYPES, type AccountType } from '@/modules/accounting/services/gl/accountSubtypes';
import {
  apportionBankLeg,
  type CashGroup,
  type ContraLine,
} from './cashFlowClassification';

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

const CASH_GROUP_LABELS: Record<CashGroup, string> = {
  cash_received_from_customers: 'Cash received from customers',
  cash_paid_to_suppliers:       'Cash paid to suppliers',
  cash_paid_to_employees:       'Cash paid to employees',
  other_operating:              'Other operating cash flows',
  investing:                    'Net investing cash flows',
  financing:                    'Net financing cash flows',
};

const OPERATING_ORDER: CashGroup[] = [
  'cash_received_from_customers',
  'cash_paid_to_suppliers',
  'cash_paid_to_employees',
  'other_operating',
];

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

interface BankLegRow {
  bank_line_id: string;
  bank_amount: string | number;
  contra_account_type: string | null;
  contra_account_subtype: string | null;
  contra_amount: string | number | null;
}

/**
 * Every cash movement in the period, with the contra lines that explain it.
 *
 * Returns one row per (cash leg x contra line). The cash leg's amount repeats
 * across those rows and MUST be counted once — `groupAllocations` does that by
 * keying on `bank_line_id`. The previous implementation summed the cash leg
 * per contra row inside SQL, which is where the double-count came from.
 *
 * This covers every posted cash journal line in the period, whether or not a
 * bank feed matched it. The old version ran one query for lines matched to
 * `bank_transactions` and a second for unmatched ones, dumping the entire
 * unmatched population into `other_operating` — so whether a movement was
 * classified at all depended on bank-feed reconciliation state rather than on
 * the accounting.
 */
async function fetchCashLegsWithContras(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<BankLegRow[]> {
  return (await sql`
    SELECT
      jl_cash.id                          AS bank_line_id,
      (jl_cash.debit - jl_cash.credit)    AS bank_amount,
      ga_contra.account_type              AS contra_account_type,
      ga_contra.account_subtype           AS contra_account_subtype,
      (jl_contra.debit - jl_contra.credit) AS contra_amount
    FROM gl_journal_lines jl_cash
    JOIN gl_journal_entries je ON je.id = jl_cash.journal_entry_id
    JOIN gl_accounts ga_cash   ON ga_cash.id = jl_cash.gl_account_id
    LEFT JOIN gl_journal_lines jl_contra
      ON jl_contra.journal_entry_id = jl_cash.journal_entry_id
     AND jl_contra.id <> jl_cash.id
     AND jl_contra.company_id = ${companyId}::UUID
    LEFT JOIN gl_accounts ga_contra
      ON ga_contra.id = jl_contra.gl_account_id
     AND ga_contra.company_id = ${companyId}::UUID
    WHERE ga_cash.account_subtype = ANY(${CASH_SUBTYPES as string[]})
      AND ga_cash.account_type = 'asset'
      AND je.status     = 'posted'
      AND jl_cash.company_id = ${companyId}::UUID
      AND je.company_id      = ${companyId}::UUID
      AND ga_cash.company_id = ${companyId}::UUID
      AND je.entry_date >= ${periodStart}
      AND je.entry_date <= ${periodEnd}
  `) as unknown as BankLegRow[];
}

/**
 * Collapse the (cash leg x contra) rows into one signed amount per cash group,
 * distributing each cash leg exactly once.
 */
function groupAllocations(rows: BankLegRow[]): Map<CashGroup, number> {
  const legs = new Map<string, { amount: number; contras: ContraLine[] }>();

  for (const r of rows) {
    const id = String(r.bank_line_id);
    let leg = legs.get(id);
    if (!leg) {
      leg = { amount: Number(r.bank_amount), contras: [] };
      legs.set(id, leg);
    }
    // A cash leg with no contra line at all yields a single row of NULLs.
    if (r.contra_account_type != null) {
      leg.contras.push({
        accountType: r.contra_account_type as AccountType,
        accountSubtype: r.contra_account_subtype,
        amount: Number(r.contra_amount ?? 0),
      });
    }
  }

  const totals = new Map<CashGroup, number>();
  for (const leg of legs.values()) {
    for (const alloc of apportionBankLeg(leg.amount, leg.contras)) {
      totals.set(alloc.cashGroup, (totals.get(alloc.cashGroup) ?? 0) + alloc.amount);
    }
  }
  return totals;
}

export async function getCashFlowDirect(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<CashFlowDirectReport> {
  try {
    const [openingCash, legRows] = await Promise.all([
      fetchOpeningCash(companyId, periodStart),
      fetchCashLegsWithContras(companyId, periodStart, periodEnd),
    ]);

    const amountByGroup = groupAllocations(legRows);

    const toItem = (group: CashGroup): DirectCashFlowItem => ({
      cashGroup: group,
      label:     CASH_GROUP_LABELS[group],
      amount:    amountByGroup.get(group) ?? 0,
    });

    // OPERATING_ORDER is the four members of OPERATING_GROUPS in presentation
    // order; filtering it against that set would never remove anything.
    const operatingItems = OPERATING_ORDER
      .map(toItem)
      .filter((i) => i.amount !== 0);

    const investingItems = [toItem('investing')].filter((i) => i.amount !== 0);
    const financingItems = [toItem('financing')].filter((i) => i.amount !== 0);

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
