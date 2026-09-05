/**
 * BalanceSheetReport → two StatementRow[] (assets; liabilities and equity).
 * Every figure is copied from the report except `Total Liabilities and
 * Equity`, which the service does not expose; it is the sum of two service
 * totals and is the single derived figure in the statement layer.
 */
import type { BalanceSheetLineItem, BalanceSheetReport } from '@/modules/accounting/types/gl.report.types';
import type { Comparison, StatementRow } from './statementModel';

type Polarity = 'asset' | 'claim'; // claim = liability or equity; going down is favourable for a liability

export interface RowOptions {
  comparative: boolean;
  /** Builds the account-detail URL for a line row. Omitted, no line links —
   * the AFS statement has no drill-down window to link into. */
  detailHref?: (accountCode: string) => string;
}

function lines(items: BalanceSheetLineItem[], polarity: Polarity, opts: RowOptions): StatementRow[] {
  const comparative = opts.comparative;
  return items.map(it => {
    const row: StatementRow = {
      id: `acc:${it.accountCode}`, kind: 'line', label: it.accountName, depth: 1,
      accountCode: it.accountCode, actual: it.balance,
    };
    // The account-detail route. Supplied by the surface rather than built
    // here: the URL carries the caller's own drill-down window.
    const href = opts.detailHref?.(it.accountCode);
    if (href !== undefined) row.href = href;
    if (comparative && it.priorBalance !== undefined) {
      const prior: Comparison = { value: it.priorBalance, variance: it.variance, variancePct: it.variancePct };
      if (it.variance !== undefined) prior.favourable = polarity === 'asset' ? it.variance >= 0 : it.variance <= 0;
      row.prior = prior;
    }
    return row;
  });
}

function block(key: string, label: string, items: BalanceSheetLineItem[], total: number, prior: number | undefined, polarity: Polarity, opts: RowOptions, emptyText: string): StatementRow[] {
  const comparative = opts.comparative;
  const head: StatementRow = { id: `sec:${key}`, kind: 'section', label, depth: 0, actual: total };
  const sub: StatementRow = { id: `sub:${key}`, kind: 'subtotal', label: `Total ${label}`, depth: 0, actual: total };
  if (comparative && prior !== undefined) {
    // Same convention as incomeStatementRows.section: an asset going up is
    // favourable, a claim going down is. Without this the balance sheet's
    // subtotals are the only uncoloured totals on the two pages. No
    // `variance`: the report has no variance field for a band total and this
    // layer does not subtract.
    sub.prior = { value: prior, favourable: polarity === 'asset' ? total >= prior : total <= prior };
  }
  // A section with no lines must say so rather than render a bare header over
  // a zero subtotal (carried from master's "No asset balances"). Its own
  // kind, `empty`: it is a placeholder, not a band header, and a non-HTML
  // consumer must be able to tell the two apart.
  const body = items.length > 0
    ? lines(items, polarity, opts)
    : [{ id: `empty:${key}`, kind: 'empty' as const, label: emptyText, depth: 1 as const, actual: 0 }];
  return [head, ...body, sub];
}

export function toBalanceSheetRows(r: BalanceSheetReport, opts: RowOptions): { assets: StatementRow[]; liabilitiesAndEquity: StatementRow[] } {
  const c = opts.comparative;
  const assets = block('assets', 'Assets', r.assets, r.totalAssets, r.priorTotalAssets, 'asset', opts, 'No asset balances');
  const le: StatementRow = {
    id: 'grand:totalLiabilitiesAndEquity', kind: 'grand', label: 'Total Liabilities and Equity', depth: 0,
    actual: r.totalLiabilities + r.totalEquity, // derived: the service has no field for this
  };
  if (c && r.priorTotalLiabilities !== undefined && r.priorTotalEquity !== undefined) {
    // Derived on the same terms as `actual` above, and for the same reason.
    le.prior = { value: r.priorTotalLiabilities + r.priorTotalEquity };
  }
  const liabilitiesAndEquity = [
    ...block('liabilities', 'Liabilities', r.liabilities, r.totalLiabilities, r.priorTotalLiabilities, 'claim', opts, 'No liability balances'),
    ...block('equity', 'Equity', r.equity, r.totalEquity, r.priorTotalEquity, 'claim', opts, 'No equity balances'),
    le,
  ];
  return { assets, liabilitiesAndEquity };
}
