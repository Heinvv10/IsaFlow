/**
 * The grid's rows in order (spec §6.2, §6.5): per band a section head, its accounts in the read
 * model's order (code order, each header directly above its sub-accounts), and "Total <band>";
 * Gross profit after cost of sales, Operating profit after operating expenses, Net profit last
 * (grand). An empty band shows no head and no total; the three profit rows always show.
 *
 * A header is a read-only roll-up line (`rollup:<id>`); a legacy header holding its own amounts
 * also gets its own editable line (`acct:<id>`, role 'own') under the roll-up.
 */
import type { GridAccount } from '@/modules/accounting/services/budgets/gridReadTypes';
import { BAND_LABEL, BAND_ORDER, type Band, type Metric } from '@/modules/accounting/services/budgets/grid/subtotals';
import type { RowKind } from '@/modules/accounting/services/budgets/grid/selection';
import type { GridLayout, LayoutRow } from './types';

export const BAND_METRIC: Readonly<Record<Band, Metric>> = {
  turnover: 'turnover', cost_of_sales: 'costOfSales', other_income: 'otherIncome',
  operating_expense: 'operatingExpenses', other_expense: 'otherExpenses',
};

/** The profit row placed after each band's total. */
const PROFIT_AFTER: Partial<Record<Band, { metric: Metric; label: string; kind: 'total' | 'grand' }>> = {
  cost_of_sales: { metric: 'grossProfit', label: 'Gross profit', kind: 'total' },
  operating_expense: { metric: 'operatingProfit', label: 'Operating profit', kind: 'total' },
  other_expense: { metric: 'netProfit', label: 'Net profit', kind: 'grand' },
};

export const accountRowKey = (accountId: string): string => `acct:${accountId}`;
export const rollupRowKey = (accountId: string): string => `rollup:${accountId}`;

type Draft = LayoutRow extends infer R ? (R extends LayoutRow ? Omit<R, 'index'> : never) : never;

export function buildLayout(accounts: readonly GridAccount[], months: readonly string[]): GridLayout {
  const draft: Draft[] = [];
  for (const band of BAND_ORDER) {
    const inBand = accounts.filter(a => a.band === band);
    if (inBand.length > 0) {
      draft.push({ kind: 'section', key: `section:${band}`, band, label: BAND_LABEL[band] });
      for (const account of inBand) {
        if (account.isHeader) {
          draft.push({ kind: 'line', key: rollupRowKey(account.id), role: 'rollup', account, band });
          if (account.ownAmounts) draft.push({ kind: 'line', key: accountRowKey(account.id), role: 'own', account, band });
        } else {
          draft.push({ kind: 'line', key: accountRowKey(account.id), role: 'account', account, band });
        }
      }
      draft.push({ kind: 'subtotal', key: `total:${band}`, band, metric: BAND_METRIC[band], label: `Total ${BAND_LABEL[band]}` });
    }
    const profit = PROFIT_AFTER[band];
    if (profit) draft.push({ kind: profit.kind, key: `profit:${profit.metric}`, metric: profit.metric, label: profit.label });
  }
  const rows = draft.map((r, index) => ({ ...r, index }) as LayoutRow);
  const rowKinds: RowKind[] = rows.map(r => r.kind);
  return { rows, months: [...months], rowKinds, cols: months.length + 1 };
}
