/**
 * The grid's CLICK wiring, in a real DOM.
 *
 * `renderToStaticMarkup` proves a button is on the page and nothing else: the
 * markup is identical whether `onClick` calls back with the row's account code
 * or with a constant, so the whole expand / evidence / drill affordance was
 * unprovable. These tests dispatch real clicks and assert what the callback
 * receives.
 *
 * Runs under `vitest.components.config.ts` (happy-dom), not the node unit
 * config: `bun run test:components`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach } from 'vitest';
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import type { StatementColumns, StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';

afterEach(cleanup);

const COLUMNS: StatementColumns = { prior: false, budget: false, variance: false, trend: false };

const rows: StatementRow[] = [
  { id: 'sec:assets', kind: 'section', label: 'Assets', depth: 0, actual: 5000000 },
  { id: 'acc:4000', kind: 'line', label: 'Sales', depth: 1, accountCode: '4000', actual: 5000000 },
  { id: 'acc:4100', kind: 'line', label: 'Other Sales', depth: 1, accountCode: '4100', actual: 250000 },
  { id: 'sub:assets', kind: 'subtotal', label: 'Total Assets', depth: 0, actual: 5250000 },
];

const linkedRows: StatementRow[] = [
  { ...rows[1]!, href: '/accounting/reports/account-detail/4000?from=2026-03-01&to=2026-08-31&source=bs' },
];

describe('StatementGrid — click wiring', () => {
  it('the toggle reports the account code of the row it is on', () => {
    const onToggleAccount = vi.fn();
    render(<StatementGrid rows={rows} columns={COLUMNS} onToggleAccount={onToggleAccount} />);
    fireEvent.click(screen.getByRole('button', { name: '4000 Sales' }));
    expect(onToggleAccount).toHaveBeenCalledTimes(1);
    expect(onToggleAccount).toHaveBeenCalledWith('4000');
  });

  it('a second row reports its OWN code, not the first one\'s', () => {
    const onToggleAccount = vi.fn();
    render(<StatementGrid rows={rows} columns={COLUMNS} onToggleAccount={onToggleAccount} />);
    fireEvent.click(screen.getByRole('button', { name: '4100 Other Sales' }));
    expect(onToggleAccount).toHaveBeenCalledWith('4100');
  });

  it('the evidence button reports the expanded account code', () => {
    const onEvidence = vi.fn();
    render(
      <StatementGrid rows={rows} columns={COLUMNS} expandedAccount="4000" onEvidence={onEvidence}
        renderDrill={code => <div>drill {code}</div>} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Evidence' }));
    expect(onEvidence).toHaveBeenCalledTimes(1);
    expect(onEvidence).toHaveBeenCalledWith('4000');
    expect(screen.getByText('drill 4000')).toBeInTheDocument();
  });

  it('a subtotal has no toggle: it is not an account', () => {
    render(<StatementGrid rows={rows} columns={COLUMNS} onToggleAccount={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Total Assets/ })).toBeNull();
  });

  it('the account link navigates and the chevron toggles, separately', () => {
    const onToggleAccount = vi.fn();
    render(<StatementGrid rows={linkedRows} columns={COLUMNS} onToggleAccount={onToggleAccount} />);
    const link = screen.getByRole('link', { name: 'Sales' });
    expect(link).toHaveAttribute(
      'href', '/accounting/reports/account-detail/4000?from=2026-03-01&to=2026-08-31&source=bs',
    );
    // The chevron is a sibling button, so clicking it toggles WITHOUT
    // following the link — and the link is not inside it.
    expect(link.closest('button')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(onToggleAccount).toHaveBeenCalledWith('4000');
  });
});
