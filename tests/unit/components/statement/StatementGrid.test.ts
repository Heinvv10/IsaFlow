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
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';

const rows: StatementRow[] = [
  { id: 'sec:revenue', kind: 'section', label: 'Turnover', depth: 0, actual: 5000000 },
  // 21.96, not 21.95: `(21.95).toFixed(1)` is "21.9" due to binary float
  // representation, which is not a bug in formatMoney/formatPct (Task 1) —
  // it's a StatementGrid consumer picking a fixture value that round-trips
  // through toFixed cleanly.
  { id: 'acc:4000', kind: 'line', label: 'Sales', depth: 1, accountCode: '4000', actual: 5000000,
    prior: { value: 4100000, variance: 900000, variancePct: 21.96, favourable: true } },
  { id: 'sub:revenue', kind: 'subtotal', label: 'Total Turnover', depth: 0, actual: 5000000, prior: { value: 4100000 } },
  { id: 'grand:netProfit', kind: 'grand', label: 'Net Profit / (Loss)', depth: 0, actual: -120000, prior: { value: 50000, favourable: false } },
];

/** The same fixture with an account-detail link and an empty-state row. */
const linkedRows: StatementRow[] = [
  { id: 'sec:assets', kind: 'section', label: 'Assets', depth: 0, actual: 0 },
  { id: 'empty:assets', kind: 'empty', label: 'No asset balances', depth: 1, actual: 0 },
  { id: 'acc:4000', kind: 'line', label: 'Sales', depth: 1, accountCode: '4000', actual: 5000000,
    href: '/accounting/reports/account-detail/4000?from=2026-03-01&to=2026-08-31&source=bs' },
];

const render = (props: Parameters<typeof StatementGrid>[0]) =>
  renderToStaticMarkup(React.createElement(StatementGrid, props));

describe('StatementGrid', () => {
  it('renders figures through formatMoney: tabular, parentheses for negatives', () => {
    const html = render({ rows, columns: { prior: false, budget: false, variance: false, trend: false } });
    expect(html).toContain('5\u00a0000\u00a0000');
    expect(html).toContain('(120\u00a0000)');
    expect(html).not.toContain('-120 000');
  });

  it('shows prior and variance columns only when asked', () => {
    const without = render({ rows, columns: { prior: false, budget: false, variance: false, trend: false } });
    expect(without).not.toContain('4\u00a0100\u00a0000');
    const withCols = render({ rows, columns: { prior: true, budget: false, variance: true, trend: false } });
    expect(withCols).toContain('4\u00a0100\u00a0000');
    expect(withCols).toContain('+22.0%');
  });

  it('marks rule weight by kind: subtotal single, grand double', () => {
    const html = render({ rows, columns: { prior: false, budget: false, variance: false, trend: false } });
    expect(html).toMatch(/<tr[^>]*data-kind="subtotal"[^>]*>[\s\S]*?Total Turnover/);
    expect(html).toMatch(/<tr[^>]*data-kind="grand"[^>]*>[\s\S]*?Net Profit/);
  });

  it('a line row is a button that reports its account code; totals are not', () => {
    const collapsed = render({ rows, columns: { prior: false, budget: false, variance: false, trend: false }, onToggleAccount: () => {} });
    const lineRowMatch = collapsed.match(/<tr[^>]*data-kind="line"[^>]*>[\s\S]*?<\/tr>/);
    expect(lineRowMatch).toBeTruthy();
    expect(lineRowMatch![0]).toContain('<button');
    expect(lineRowMatch![0]).toContain('aria-expanded="false"');
    const grandRowMatch = collapsed.match(/<tr[^>]*data-kind="grand"[^>]*>[\s\S]*?<\/tr>/);
    expect(grandRowMatch![0]).not.toContain('<button');

    const expanded = render({
      rows, columns: { prior: false, budget: false, variance: false, trend: false },
      onToggleAccount: () => {}, expandedAccount: '4000',
    });
    const expandedLineRow = expanded.match(/<tr[^>]*data-kind="line"[^>]*>[\s\S]*?<\/tr>/);
    expect(expandedLineRow![0]).toContain('aria-expanded="true"');
  });

  it('renders the drill row under the expanded account only', () => {
    const withDrill = render({
      rows, columns: { prior: false, budget: false, variance: false, trend: false },
      expandedAccount: '4000', renderDrill: code => React.createElement('div', null, `drill for ${code}`),
    });
    expect(withDrill).toContain('drill for 4000');
    expect(withDrill).toContain('data-kind="drill"');

    const withoutExpanded = render({
      rows, columns: { prior: false, budget: false, variance: false, trend: false },
      renderDrill: code => React.createElement('div', null, `drill for ${code}`),
    });
    expect(withoutExpanded).not.toContain('drill for 4000');
    expect(withoutExpanded).not.toContain('data-kind="drill"');
  });

  it('offers the evidence drill only inside an expanded account row', () => {
    const both = render({
      rows, columns: { prior: false, budget: false, variance: false, trend: false },
      expandedAccount: '4000', onEvidence: () => {},
      renderDrill: code => React.createElement('div', null, `drill for ${code}`),
    });
    const drillRow = both.match(/<tr[^>]*data-kind="drill"[^>]*>[\s\S]*?<\/tr>/)![0];
    expect(drillRow).toContain('Evidence');
    expect(drillRow).toContain('drill for 4000');

    // No handler: no button, even expanded.
    const noHandler = render({
      rows, columns: { prior: false, budget: false, variance: false, trend: false },
      expandedAccount: '4000',
      renderDrill: code => React.createElement('div', null, `drill for ${code}`),
    });
    expect(noHandler).not.toContain('Evidence');

    // Handler but nothing expanded: no drill row at all.
    const collapsed = render({
      rows, columns: { prior: false, budget: false, variance: false, trend: false }, onEvidence: () => {},
    });
    expect(collapsed).not.toContain('Evidence');
    expect(collapsed).not.toContain('data-kind="drill"');
  });

  it('renders the rand movement, not only the percentage', () => {
    const html = render({ rows, columns: { prior: true, budget: false, variance: true, trend: false } });
    // Master's balance sheet showed `+R12 345` on every line and the first
    // migration to this grid dropped it, leaving the reader a bar and a
    // percentage with no amount.
    expect(html).toContain('+900\u00a0000');
    expect(html).toContain('Δ Prior');
  });

  it('links the label to account detail when the row carries an href', () => {
    const html = render({ rows: linkedRows, columns: { prior: false, budget: false, variance: false, trend: false }, onToggleAccount: () => {} });
    expect(html).toContain('href="/accounting/reports/account-detail/4000?from=2026-03-01&amp;to=2026-08-31&amp;source=bs"');
    // The chevron toggle is a SIBLING of the link, never its parent: an
    // anchor inside a button is invalid and swallows one of the two actions.
    const lineRow = html.match(/<tr[^>]*data-kind="line"[^>]*>[\s\S]*?<\/tr>/)![0];
    expect(lineRow).toContain('<button');
    expect(lineRow).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<a /);
  });

  it('an empty-state row shows its label and no figure', () => {
    const html = render({ rows: linkedRows, columns: { prior: false, budget: false, variance: false, trend: false } });
    const emptyRow = html.match(/<tr[^>]*data-kind="empty"[^>]*>[\s\S]*?<\/tr>/);
    expect(emptyRow, 'the placeholder has its own kind').toBeTruthy();
    expect(emptyRow![0]).toContain('No asset balances');
    expect(emptyRow![0]).not.toContain('<button');
    expect(emptyRow![0].replace(/<[^>]*>/g, '').replace('No asset balances', '')).not.toMatch(/[0-9]/);
  });

  it('never renders a figure that is not in rows', () => {
    const html = render({ rows, columns: { prior: true, budget: false, variance: true, trend: false } });
    // Read the figure CELLS, not the digits of the whole page: "4 100 000"
    // contains "100000" as a substring, so a concatenated-digits check reports
    // arithmetic that never happened and misses the arithmetic that did.
    const cells = [...html.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map(m => m[1]!.trim());
    const figures = cells
      .filter(t => /[0-9]/.test(t) && !t.endsWith('%'))
      .map(t => Number(t.replace(/[()+\u2212\s]/g, '')) * (t.startsWith('(') ? -1 : 1));
    // Every figure in the fixture, and every pairwise sum and difference of
    // them. Naming one derived total catches only the slip you thought of.
    const given = [5000000, 4100000, 900000, -120000, 50000];
    const allowed = new Set(given.map(Math.abs));
    const derived = new Set<number>();
    for (const a of given) {
      for (const b of given) {
        for (const d of [a + b, a - b]) if (!allowed.has(Math.abs(d))) derived.add(Math.abs(d));
      }
    }
    expect(derived.size).toBeGreaterThan(5);
    for (const f of figures) {
      expect(allowed, `rendered ${f}`).toContain(Math.abs(f));
      expect(derived.has(Math.abs(f)), `derived ${f}`).toBe(false);
    }
    expect(figures.length).toBeGreaterThan(3);
  });
});
