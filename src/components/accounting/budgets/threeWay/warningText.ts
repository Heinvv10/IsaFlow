/**
 * The engine's and the service's three-way warnings (`ThreeWayWarning`, `ServiceWarning`) in words for the header.
 * Money is cents on the wire; shown in rands.
 */
import { formatStatementFigure } from '@/lib/format/money';
import type { ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';

export type AnyWarning = ThreeWayView['warnings'][number];

const R = (cents: number): string => formatStatementFigure(cents / 100, { symbol: true, cents: true });
const list = (xs: readonly string[]): string => xs.join(', ');

const FLOW: Record<string, string> = { receipts: 'Receipts', stock_purchases: 'Stock purchases', supplier_payments: 'Supplier payments' };

export function warningText(w: AnyWarning): string {
  switch (w.code) {
    case 'opening_provisional': return `Opening balances are provisional: as at ${w.asAt} (today), not the day before the year starts.`;
    case 'opening_cent_difference': return `The opening balance sheet was ${R(w.cents)} out; the difference went to retained earnings.`;
    case 'negative_cash': return `Cash below zero in ${list(w.months)}. It is shown, not funded.`;
    case 'unmapped_balance': return `Opening balances carried flat in "other" lines: ${list(w.accounts.map((a) => a.accountCode))}.`;
    case 'depreciation_check': return `Budgeted depreciation ${R(w.budgeted)} differs from the asset register's ${R(w.check)} by more than 5 %.`;
    case 'interest_check': return `Budgeted finance cost ${R(w.budgeted)} differs from the loan schedules' interest ${R(w.check)} by more than 5 %.`;
    case 'lookback_short': return `Fewer than 12 months of actuals behind the ${w.series} days (${list(w.months)}).`;
    case 'outside_months': return `Entries outside this version's months were skipped: ${w.entries.map((e) => e.detail).join('; ')}.`;
    case 'loan_schedule_missing': return `No repayment schedule for loan(s) ${list(w.loanIds)}.`;
    case 'provisional_tax_not_applicable': return `Provisional tax is on, but does not apply to a ${w.entityType} entity; none is budgeted.`;
    case 'top_up_offset_not_sars': return `The tax top-up month (${w.value} months after the prior year end) differs from SARS's ${w.sars}.`;
    case 'opening_debit_carried': return `A debit opening ${w.bucket === 'payrollLiabilities' ? 'payroll liability' : 'income tax payable'} of ${R(w.amount)} is carried flat, not refunded.`;
    case 'negative_flow': return `${FLOW[w.flow] ?? w.flow} came out negative in ${w.month} (${R(w.amount)}); kept so the balance sheet holds.`;
    case 'opening_cash_difference': return `Opening cash differs from the cash book by ${R(w.differenceCents)} (accounts ${list(w.accounts)}).`;
  }
}
