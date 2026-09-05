/**
 * BalanceSheetReport → two StatementRow[] (assets; liabilities and equity).
 * Every figure is copied from the report except `Total Liabilities and
 * Equity`, which the service does not expose; it is the sum of two service
 * totals and is the single derived figure in the statement layer.
 */
import type { BalanceSheetLineItem, BalanceSheetReport } from '@/modules/accounting/types/gl.report.types';
import type { StatementRow } from './statementModel';

type Polarity = 'asset' | 'claim'; // claim = liability or equity; going down is favourable for a liability

function lines(items: BalanceSheetLineItem[], polarity: Polarity, comparative: boolean): StatementRow[] {
  return items.map(it => {
    const row: StatementRow = {
      id: `acc:${it.accountCode}`, kind: 'line', label: it.accountName, depth: 1,
      accountCode: it.accountCode, actual: it.balance,
    };
    if (comparative && it.priorBalance !== undefined) {
      row.prior = it.priorBalance; row.variance = it.variance; row.variancePct = it.variancePct;
      if (it.variance !== undefined) row.favourable = polarity === 'asset' ? it.variance >= 0 : it.variance <= 0;
    }
    return row;
  });
}

function block(key: string, label: string, items: BalanceSheetLineItem[], total: number, prior: number | undefined, polarity: Polarity, comparative: boolean, emptyText: string): StatementRow[] {
  const head: StatementRow = { id: `sec:${key}`, kind: 'section', label, depth: 0, actual: total };
  const sub: StatementRow = { id: `sub:${key}`, kind: 'subtotal', label: `Total ${label}`, depth: 0, actual: total };
  if (comparative && prior !== undefined) {
    sub.prior = prior;
    // Same convention as incomeStatementRows.section: an asset going up is
    // favourable, a claim going down is. Without this the balance sheet's
    // subtotals are the only uncoloured totals on the two pages.
    sub.favourable = polarity === 'asset' ? total >= prior : total <= prior;
  }
  // A section with no lines must say so rather than render a bare header over
  // a zero subtotal (carried from master's "No asset balances").
  const body = items.length > 0
    ? lines(items, polarity, comparative)
    : [{ id: `empty:${key}`, kind: 'section' as const, label: emptyText, depth: 1 as const, actual: 0 }];
  return [head, ...body, sub];
}

export function toBalanceSheetRows(r: BalanceSheetReport, opts: { comparative: boolean }): { assets: StatementRow[]; liabilitiesAndEquity: StatementRow[] } {
  const c = opts.comparative;
  const assets = block('assets', 'Assets', r.assets, r.totalAssets, r.priorTotalAssets, 'asset', c, 'No asset balances');
  const le: StatementRow = {
    id: 'grand:totalLiabilitiesAndEquity', kind: 'grand', label: 'Total Liabilities and Equity', depth: 0,
    actual: r.totalLiabilities + r.totalEquity, // derived: the service has no field for this
  };
  if (c && r.priorTotalLiabilities !== undefined && r.priorTotalEquity !== undefined) {
    le.prior = r.priorTotalLiabilities + r.priorTotalEquity;
  }
  const liabilitiesAndEquity = [
    ...block('liabilities', 'Liabilities', r.liabilities, r.totalLiabilities, r.priorTotalLiabilities, 'claim', c, 'No liability balances'),
    ...block('equity', 'Equity', r.equity, r.totalEquity, r.priorTotalEquity, 'claim', c, 'No equity balances'),
    le,
  ];
  return { assets, liabilitiesAndEquity };
}
