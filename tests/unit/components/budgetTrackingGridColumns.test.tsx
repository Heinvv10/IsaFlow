/**
 * Budgets P3 PR-B (T8): the statement grid's additive fields. Projection cells
 * (Projected FY, FY budget, Δ) render only when `columns.projection` is set; an
 * absent comparison prints "—" (never the zero dash, never 0), with no bar and
 * no colour, and a marker saying why when the engine gave a reason. Every other
 * surface's output is unchanged: the income-statement and balance-sheet HTML is
 * pinned by a snapshot recorded on master's grid before this change.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import type { StatementColumns, StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import { toBudgetTrackingRows } from '@/modules/accounting/services/reports/statementRows/budgetTrackingRows';
import { buildTrackingLines, type AccountMeta } from '@/modules/accounting/services/budgets/tracking/trackingLines';
import { buildBands } from '@/modules/accounting/services/budgets/tracking/trackingBands';
import { projectionPlan } from '@/modules/accounting/services/budgets/tracking/trackingProjection';

const render = (rows: StatementRow[], columns: StatementColumns) =>
  renderToStaticMarkup(React.createElement(StatementGrid, { rows, columns }));

// Income statement and balance sheet rows as their adapters emit them: prior and budget comparators.
const IS_ROWS: StatementRow[] = [
  { id: 'sec:revenue', kind: 'section', label: 'Turnover', depth: 0, actual: 5000000 },
  { id: 'acc:4000', kind: 'line', label: 'Sales', depth: 1, accountCode: '4000', actual: 5000000,
    prior: { value: 4100000, variance: 900000, variancePct: 21.96, favourable: true },
    budget: { value: 4800000, variance: 200000, variancePct: 4.17, favourable: true } },
  { id: 'acc:4100', kind: 'line', label: 'Other sales', depth: 1, accountCode: '4100', actual: 0,
    budget: { value: 0, variance: 0, favourable: true } },
  { id: 'sub:revenue', kind: 'subtotal', label: 'Total Turnover', depth: 0, actual: 5000000, prior: { value: 4100000, favourable: true } },
  { id: 'grand:netProfit', kind: 'grand', label: 'Net Profit / (Loss)', depth: 0, actual: -120000, prior: { value: 50000, favourable: false } },
];
const BS_ROWS: StatementRow[] = [
  { id: 'sec:assets', kind: 'section', label: 'Assets', depth: 0, actual: 0 },
  { id: 'empty:assets', kind: 'empty', label: 'No asset balances', depth: 1, actual: 0 },
  { id: 'acc:1000', kind: 'line', label: 'Bank', depth: 1, accountCode: '1000', actual: 250000,
    href: '/accounting/reports/account-detail/1000?from=2026-03-01&to=2026-08-31&source=bs',
    prior: { value: 200000, variance: 50000, variancePct: 25, favourable: true } },
];
const ALL_OFF: StatementColumns = { prior: false, budget: false, variance: false, trend: false };
const FULL: StatementColumns = { prior: true, budget: true, variance: true, trend: false };

describe('every other surface is unchanged', () => {
  it('income statement and balance sheet HTML equal the snapshot taken on master', () => {
    expect({
      isOff: render(IS_ROWS, ALL_OFF), isFull: render(IS_ROWS, FULL),
      bsOff: render(BS_ROWS, ALL_OFF), bsFull: render(BS_ROWS, FULL),
    }).toMatchSnapshot();
  });
});

// A tracking report: sales budgeted (with a projection), rent unbudgeted, wages partial.
function trackingRows() {
  const meta = (accountId: string, accountCode: string, accountType: 'revenue' | 'expense'): AccountMeta =>
    ({ accountId, accountCode, accountName: `Name ${accountCode}`, accountType, accountSubtype: null });
  const accounts = new Map([['sales', meta('sales', '4000', 'revenue')], ['rent', meta('rent', '6000', 'expense')], ['wages', meta('wages', '6100', 'expense')]]);
  const plan = projectionPlan({ fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28' }, '2026-06-30', '2026-10-26');
  const M = '2026-06';
  const lines = buildTrackingLines({
    accounts, windowMonths: [M], plan,
    actuals: [{ accountId: 'sales', month: M, amount: 1000 }, { accountId: 'rent', month: M, amount: 200 }, { accountId: 'wages', month: M, amount: 50 }],
    budgets: [{ accountId: 'sales', month: M, amount: 900, cls: 'included' }, { accountId: 'wages', month: M, amount: 70, cls: 'coarser' }],
  });
  return toBudgetTrackingRows({ lines, bands: buildBands(lines) });
}

describe('projection cells', () => {
  it('render only when columns.projection is set', () => {
    const rows = trackingRows();
    const off = render(rows, { ...FULL, prior: false });
    expect(off).not.toContain('Projected FY');
    expect(off).not.toContain('data-col="projected"');
    const on = render(rows, { ...FULL, prior: false, projection: true });
    expect(on).toContain('Projected FY');
    expect(on).toContain('FY budget');
    // One set of projection cells per row, so the columns line up (a section row's are blank).
    expect((on.match(/data-col="projected"/g) ?? []).length).toBe(rows.length);
  });
});

describe('absent comparisons', () => {
  const html = render(trackingRows(), { ...FULL, prior: false, projection: true });
  // Without onToggle a line prints its label (`Name <code>`), not the code tag.
  const rowHtml = (code: string) => {
    const at = html.indexOf(`>Name ${code}<`);
    expect(at, `row ${code} not rendered`).toBeGreaterThan(0);
    return html.slice(at, html.indexOf('</tr>', at));
  };

  it('an unbudgeted line prints "—" in Budget, Var R and Var %, with no bar and no colour', () => {
    const rent = rowHtml('6000');
    expect((rent.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(rent).not.toContain('var(--ff-fav)');
    expect(rent).not.toContain('var(--ff-unfav)');
    expect(rent).not.toContain('relative h-4');
    expect(rent).toContain('title="No budget"');
  });

  it('a budget set above the filter is marked so', () => {
    expect(rowHtml('6100')).toContain('Budget set above this filter');
  });

  it('a budgeted line still prints its figures and colour', () => {
    const sales = rowHtml('4000');
    expect(sales).toContain('900');
    expect(sales).toContain('var(--ff-fav)');
    expect(sales).not.toContain('—');
  });
});
