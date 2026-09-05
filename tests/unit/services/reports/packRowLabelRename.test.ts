/**
 * A band's identity is its KEY, not its display label.
 *
 * The kind and id maps used to be keyed by label. Rewording "Gross Profit" in
 * `incomeStatementPackRows` compiled clean and silently demoted that band to
 * `id: 'sub:<new label>'`, `kind: 'subtotal'` — the reconciling totals stop
 * being marked as totals on a document sent to a client. The label-for-label
 * test in packMappers.test.ts moves WITH such a rename, so it cannot catch it.
 *
 * This file renames every label at the source and asserts nothing about the
 * row structure moves.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PackPandLRow } from '@/modules/accounting/services/reports/incomeStatementPackRows';

const RENAMED: PackPandLRow[] = [
  { key: 'revenue', label: 'Sales (restated)', amount: 100 },
  { key: 'costOfSales', label: 'Direct Costs', amount: 40 },
  { key: 'grossProfit', label: 'Contribution', amount: 60, margin: 60 },
  { key: 'otherIncome', label: 'Sundry Income', amount: 5 },
  { key: 'operatingExpenses', label: 'Overheads', amount: 10 },
  { key: 'operatingProfit', label: 'EBIT', amount: 55 },
  { key: 'otherExpenses', label: 'Finance Costs', amount: 5 },
  { key: 'netProfit', label: 'Bottom Line', amount: 50, margin: 50 },
];

vi.mock('@/modules/accounting/services/reports/incomeStatementPackRows', () => ({
  incomeStatementPackRows: () => RENAMED,
}));

import { toManagementPandLRows } from '@/modules/accounting/services/reports/statementRows/packMappers';

describe('a label rename does not demote a total', () => {
  const rows = () => toManagementPandLRows({ totalRevenue: 100 });

  it('keeps every id, whatever the labels say', () => {
    expect(rows().map(r => r.id)).toEqual([
      'sub:revenue', 'sub:costOfSales', 'total:grossProfit', 'sub:otherIncome',
      'sub:operatingExpenses', 'total:operatingProfit', 'sub:otherExpenses', 'grand:netProfit',
    ]);
  });

  it('keeps the reconciling totals marked as totals', () => {
    const kind = (id: string) => rows().find(r => r.id === id)!.kind;
    expect(kind('total:grossProfit')).toBe('total');
    expect(kind('total:operatingProfit')).toBe('total');
    expect(kind('grand:netProfit')).toBe('grand');
    expect(kind('sub:revenue')).toBe('subtotal');
  });

  it('shows the renamed labels, since those ARE display text', () => {
    // Renaming a band is allowed. Losing its rule weight is not.
    expect(rows().map(r => r.label)).toContain('Contribution');
    expect(rows().map(r => r.label)).toContain('Overheads');
    // The bottom line is the one exception, overridden on purpose: the screen
    // has always named it more fully than the packs do.
    expect(rows().find(r => r.id === 'grand:netProfit')!.label).toBe('Net Profit / (Loss)');
  });

  it('carries the amounts through unchanged', () => {
    expect(rows().map(r => r.actual)).toEqual([100, 40, 60, 5, 10, 55, 5, 50]);
  });
});
