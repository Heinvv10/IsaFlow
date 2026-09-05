/**
 * IncomeStatementReport → StatementRow[]. Every figure is COPIED from the
 * report; nothing is derived here. Band order is the reconciling order:
 * Turnover, Cost of Sales, Gross Profit, Other Income, Operating Expenses,
 * Operating Profit, Other Expenses, Net Profit. Other income sits above the
 * operating line on purpose (see incomeStatementService and B75).
 */
import type { IncomeStatementLineItem, IncomeStatementReport } from '@/modules/accounting/types/gl.report.types';
import type { StatementRow } from './statementModel';
import { priorComparison } from './comparators';

type Polarity = 'income' | 'expense';

function lineRows(items: IncomeStatementLineItem[], polarity: Polarity, comparative: boolean): StatementRow[] {
  return items.map(it => {
    const row: StatementRow = {
      id: `acc:${it.accountCode}`, kind: 'line', label: it.accountName, depth: 1,
      accountCode: it.accountCode, actual: it.amount,
    };
    if (comparative && it.priorAmount !== undefined) {
      row.prior = priorComparison(it.priorAmount, it.variance, it.variancePct,
        v => (polarity === 'income' ? v >= 0 : v <= 0));
    }
    return row;
  });
}

function section(
  key: string, label: string, items: IncomeStatementLineItem[], total: number, prior: number | undefined,
  polarity: Polarity, comparative: boolean,
): StatementRow[] {
  const head: StatementRow = { id: `sec:${key}`, kind: 'section', label, depth: 0, actual: total };
  const sub: StatementRow = { id: `sub:${key}`, kind: 'subtotal', label: `Total ${label}`, depth: 0, actual: total };
  if (comparative && prior !== undefined) {
    // No `variance` here: the report has no variance field for a band total
    // and this layer does not subtract. Only `favourable`, which is a
    // polarity judgement, not a figure.
    sub.prior = { value: prior, favourable: polarity === 'income' ? total >= prior : total <= prior };
  }
  return [head, ...lineRows(items, polarity, comparative), sub];
}

function total(id: string, kind: 'total' | 'grand', label: string, actual: number, prior: number | undefined, comparative: boolean): StatementRow {
  const row: StatementRow = { id, kind, label, depth: 0, actual };
  if (comparative && prior !== undefined) {
    row.prior = { value: prior, favourable: actual >= prior };
  }
  return row;
}

export function toIncomeStatementRows(r: IncomeStatementReport, opts: { comparative: boolean }): StatementRow[] {
  const c = opts.comparative;
  const rows: StatementRow[] = [
    ...section('revenue', 'Turnover', r.revenue, r.totalRevenue, r.priorTotalRevenue, 'income', c),
  ];
  if (r.costOfSales.length > 0) {
    rows.push(...section('costOfSales', 'Cost of Sales', r.costOfSales, r.totalCostOfSales, r.priorTotalCostOfSales, 'expense', c));
  }
  rows.push(total('total:grossProfit', 'total', 'Gross Profit', r.grossProfit, r.priorGrossProfit, c));
  if (r.otherIncome.length > 0) {
    rows.push(...section('otherIncome', 'Other Income', r.otherIncome, r.totalOtherIncome, r.priorTotalOtherIncome, 'income', c));
  }
  rows.push(...section('operatingExpenses', 'Operating Expenses', r.operatingExpenses, r.totalOperatingExpenses, r.priorTotalOperatingExpenses, 'expense', c));
  rows.push(total('total:operatingProfit', 'total', 'Operating Profit', r.operatingProfit, r.priorOperatingProfit, c));
  if (r.otherExpenses.length > 0) {
    rows.push(...section('otherExpenses', 'Other Expenses', r.otherExpenses, r.totalOtherExpenses, r.priorTotalOtherExpenses, 'expense', c));
  }
  rows.push(total('grand:netProfit', 'grand', 'Net Profit / (Loss)', r.netProfit, r.priorNetProfit, c));
  return rows;
}
