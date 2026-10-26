/**
 * Report grids pin their header row to the page scroll (master plan 3b.3): EVERY header cell is sticky,
 * not only the first two - the comparator, variance, delta and trend columns scroll sideways with the page
 * and a header that scrolls away from its column is unreadable. A browser run forces a wide table and
 * checks the first and last cell; this covers every column the grid can print, with all of them on.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import type { StatementColumns, StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';

afterEach(cleanup);

const ALL: StatementColumns = { prior: true, budget: true, variance: true, trend: true };
const rows: StatementRow[] = [
  { id: 'sec:inc', kind: 'section', label: 'Income', depth: 0, actual: 100 },
  {
    id: 'acc:4000', kind: 'line', label: 'Sales', depth: 1, accountCode: '4000', actual: 100,
    prior: { value: 80, variance: 20, variancePct: 25, favourable: true },
    budget: { value: 90, variance: 10, variancePct: 11, favourable: true },
    trend: [1, 2, 3],
  },
  { id: 'sub:inc', kind: 'subtotal', label: 'Total Income', depth: 0, actual: 100 },
];

function headers(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('thead th'));
}

describe('StatementGrid sticky header', () => {
  it('pins every header cell to the top, and the first also to the left, with all columns on', () => {
    const { container } = render(<StatementGrid rows={rows} columns={ALL} title="Income" sticky />);
    const ths = headers(container);
    // label + Actual + (Prior, delta, variance bar, delta %) + (Budget, ...) + 12 mo
    expect(ths).toHaveLength(2 + 4 + 4 + 1);
    for (const th of ths) {
      expect(th.className, `header "${th.textContent}"`).toMatch(/(^|\s)sticky(\s|$)/);
      expect(th.className, `header "${th.textContent}"`).toMatch(/(^|\s)top-0(\s|$)/);
      expect(th.className, `header "${th.textContent}"`).toMatch(/(^|\s)bg-\[var\(--ff-bg-secondary\)\]/);
    }
    expect(ths[0]!.className).toMatch(/(^|\s)left-0(\s|$)/);
    expect(ths.slice(1).some((th) => /(^|\s)left-0(\s|$)/.test(th.className))).toBe(false);
  });

  it('pins the first column of every body row, and the expanded drill row spans every header column', () => {
    const { container } = render(
      <StatementGrid rows={rows} columns={ALL} sticky expandedAccount="4000" renderDrill={() => <p>drill</p>} />,
    );
    for (const tr of Array.from(container.querySelectorAll('tbody tr[data-kind]')).filter((r) => r.getAttribute('data-kind') !== 'drill')) {
      expect(tr.querySelector('td:first-child')!.className, `row ${tr.getAttribute('data-kind')}`).toMatch(/(^|\s)sticky(\s|$)/);
    }
    const drill = container.querySelector('tr[data-kind="drill"] td')!;
    expect(Number(drill.getAttribute('colspan'))).toBe(headers(container).length);
  });

  it('is off by default: share, slide and pack surfaces render the table as before', () => {
    const { container } = render(<StatementGrid rows={rows} columns={ALL} />);
    for (const th of headers(container)) expect(th.className).not.toMatch(/(^|\s)sticky(\s|$)/);
    expect(container.firstElementChild!.className).toContain('overflow-x-auto');
  });
});
