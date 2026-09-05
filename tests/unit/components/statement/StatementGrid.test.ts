/**
 * StatementGrid — the one statement renderer. It must never compute a
 * figure, only render StatementRow[] as given. Rendered with
 * renderToStaticMarkup, same pattern as incomeStatementRenderSurfaces.test.ts,
 * per controller ruling (no @testing-library/react, no happy-dom).
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import type { StatementRow } from '@/components/accounting/statement/statementModel';

const rows: StatementRow[] = [
  { id: 'sec:revenue', kind: 'section', label: 'Turnover', depth: 0, actual: 5000000 },
  // 21.96, not 21.95: `(21.95).toFixed(1)` is "21.9" due to binary float
  // representation, which is not a bug in formatMoney/formatPct (Task 1) —
  // it's a StatementGrid consumer picking a fixture value that round-trips
  // through toFixed cleanly.
  { id: 'acc:4000', kind: 'line', label: 'Sales', depth: 1, accountCode: '4000', actual: 5000000, prior: 4100000, variance: 900000, variancePct: 21.96, favourable: true },
  { id: 'sub:revenue', kind: 'subtotal', label: 'Total Turnover', depth: 0, actual: 5000000, prior: 4100000 },
  { id: 'grand:netProfit', kind: 'grand', label: 'Net Profit / (Loss)', depth: 0, actual: -120000, prior: 50000, favourable: false },
];

const render = (props: Parameters<typeof StatementGrid>[0]) =>
  renderToStaticMarkup(React.createElement(StatementGrid, props));

describe('StatementGrid', () => {
  it('renders figures through formatMoney: tabular, parentheses for negatives', () => {
    const html = render({ rows, columns: { prior: false, variance: false, trend: false } });
    expect(html).toContain('5 000 000');
    expect(html).toContain('(120 000)');
    expect(html).not.toContain('-120 000');
  });

  it('shows prior and variance columns only when asked', () => {
    const without = render({ rows, columns: { prior: false, variance: false, trend: false } });
    expect(without).not.toContain('4 100 000');
    const withCols = render({ rows, columns: { prior: true, variance: true, trend: false } });
    expect(withCols).toContain('4 100 000');
    expect(withCols).toContain('+22.0%');
  });

  it('marks rule weight by kind: subtotal single, grand double', () => {
    const html = render({ rows, columns: { prior: false, variance: false, trend: false } });
    expect(html).toMatch(/<tr[^>]*data-kind="subtotal"[^>]*>[\s\S]*?Total Turnover/);
    expect(html).toMatch(/<tr[^>]*data-kind="grand"[^>]*>[\s\S]*?Net Profit/);
  });

  it('a line row is a button that reports its account code; totals are not', () => {
    const collapsed = render({ rows, columns: { prior: false, variance: false, trend: false }, onToggleAccount: () => {} });
    const lineRowMatch = collapsed.match(/<tr[^>]*data-kind="line"[^>]*>[\s\S]*?<\/tr>/);
    expect(lineRowMatch).toBeTruthy();
    expect(lineRowMatch![0]).toContain('<button');
    expect(lineRowMatch![0]).toContain('aria-expanded="false"');
    const grandRowMatch = collapsed.match(/<tr[^>]*data-kind="grand"[^>]*>[\s\S]*?<\/tr>/);
    expect(grandRowMatch![0]).not.toContain('<button');

    const expanded = render({
      rows, columns: { prior: false, variance: false, trend: false },
      onToggleAccount: () => {}, expandedAccount: '4000',
    });
    const expandedLineRow = expanded.match(/<tr[^>]*data-kind="line"[^>]*>[\s\S]*?<\/tr>/);
    expect(expandedLineRow![0]).toContain('aria-expanded="true"');
  });

  it('renders the drill row under the expanded account only', () => {
    const withDrill = render({
      rows, columns: { prior: false, variance: false, trend: false },
      expandedAccount: '4000', renderDrill: code => React.createElement('div', null, `drill for ${code}`),
    });
    expect(withDrill).toContain('drill for 4000');
    expect(withDrill).toContain('data-kind="drill"');

    const withoutExpanded = render({
      rows, columns: { prior: false, variance: false, trend: false },
      renderDrill: code => React.createElement('div', null, `drill for ${code}`),
    });
    expect(withoutExpanded).not.toContain('drill for 4000');
    expect(withoutExpanded).not.toContain('data-kind="drill"');
  });

  it('never renders a figure that is not in rows', () => {
    const html = render({ rows, columns: { prior: true, variance: true, trend: false } });
    const digits = html.replace(/[^0-9]/g, '');
    // 5000000, 4100000, 900000, 120000, 50000, 22.0 → all from rows. A derived sum like 4 880 000 must not appear.
    expect(digits).not.toContain('4880000');
  });
});
