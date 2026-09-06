/**
 * A movement with no percentage behind it must still print the movement.
 *
 * `priorComparison` drops `variancePct` when the prior is exactly zero — there
 * is no denominator — but keeps the amount and its polarity, because going
 * from nothing to R5.5m is the reader's whole interest in that row. The grid
 * reads the two fields independently; nothing pinned that it does.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import { priorComparison } from '@/modules/accounting/services/reports/statementRows/comparators';
import type { StatementColumns, StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';

afterEach(cleanup);

const COLUMNS: StatementColumns = { prior: true, budget: false, variance: true, trend: false };

const rowWithZeroPrior = (): StatementRow[] => ([
  {
    id: 'acc:4100', kind: 'line', label: 'Sales Revenue', depth: 1,
    accountCode: '4100', actual: 5_535_000,
    prior: priorComparison(0, 5_535_000, v => v >= 0),
  },
]);

describe('a zero prior in the grid', () => {
  it('prints the movement amount', () => {
    render(<StatementGrid rows={rowWithZeroPrior()} columns={COLUMNS} title="P&L" />);
    expect(screen.getByText('+5 535 000')).toBeInTheDocument();
  });

  it('draws the variance bar, because there is a variance to draw', () => {
    const { container } = render(<StatementGrid rows={rowWithZeroPrior()} columns={COLUMNS} title="P&L" />);
    expect(container.querySelectorAll('td.w-36 > *').length).toBe(1);
  });

  it('leaves the Δ% cell empty rather than printing a 0.0% nobody measured', () => {
    const { container } = render(<StatementGrid rows={rowWithZeroPrior()} columns={COLUMNS} title="P&L" />);
    const cells = container.querySelector('tbody tr')!.querySelectorAll('td');
    // label · Actual · Prior · Δ Prior · bar · Δ%
    expect(cells[cells.length - 1]!.textContent).toBe('');
  });

  it('still prints a percentage when the prior gives one a denominator', () => {
    const rows: StatementRow[] = [{
      id: 'acc:4100', kind: 'line', label: 'Sales Revenue', depth: 1,
      accountCode: '4100', actual: 5_535_000,
      prior: priorComparison(4_000_000, 1_535_000, v => v >= 0),
    }];
    const { container } = render(<StatementGrid rows={rows} columns={COLUMNS} title="P&L" />);
    const cells = container.querySelector('tbody tr')!.querySelectorAll('td');
    expect(cells[cells.length - 1]!.textContent).toContain('%');
  });
});
