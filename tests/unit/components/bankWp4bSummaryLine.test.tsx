/**
 * WP4b: the statement panel and the tiles collapse into ONE summary line (name · Statement · Ledger · Difference · tile
 * chips) with a "Details" expander that holds the full statement panel. The status tiles are toggle buttons
 * (aria-pressed) that drive the list's status filter; the Excluded tile opens the Excluded tab. Awaiting review is a
 * different cut (not a status bucket), so it stays a plain figure.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BankTxStatsStrip } from '@/components/accounting/bank-transactions/BankTxStatsStrip';
import { statusTileClick, statusTilePressed } from '@/components/accounting/bank-transactions/bankTxStatusTiles';
import { summaryAcct } from '../helpers/bankSummaryFixture';
import type { StatementRef } from '@/modules/accounting/services/bank/bankAccountSummaryService';

vi.mock('next/link', () => ({ default: ({ children, href, ...r }: { children: React.ReactNode; href: string }) => <a href={href} {...r}>{children}</a> }));
afterEach(cleanup);

const ref = (o: Partial<StatementRef> = {}): StatementRef => ({
  batchId: 'b1', statementDate: '2026-10-31', sourceLabel: 'FNB', balanceSource: 'running_balance',
  openingCents: 100000, closingCents: 250000, lineCount: 12, importedAt: '2026-11-02T08:00:00.000Z', ...o,
});
const counts = { posted: 20, allocated: 9, provisional: 2, suggested: 4, unallocated: 5, excluded: 2, awaitingReview: 11, pendingAtBank: 0 };
const latest = ref();
const bank = summaryAcct('a1', { accountName: 'FNB Cheque', accountCode: '1110', ledgerCents: 249000, counts,
  statement: { latest, lastWithBalance: latest, ledgerAtStatementCents: 249000, differenceCents: 1000 } });
const strip = (o: Partial<React.ComponentProps<typeof BankTxStatsStrip>> = {}) => (
  <BankTxStatsStrip bank={bank} shown={null} onShowProvisional={vi.fn()} tab="new" allocationFilter="all" onTile={vi.fn()} {...o} />
);
const flat = (s: string | null) => (s ?? '').replace(/[  ]/g, ' ');

describe('the summary line', () => {
  it('is one line: name, Statement, Ledger and Difference figures, then the tile chips', () => {
    render(strip());
    const line = flat(screen.getByTestId('bank-summary-line').textContent);
    expect(line).toContain('FNB Cheque');
    expect(line).toContain('Statement R 2 500.00');
    expect(line).toContain('Ledger R 2 490.00');
    expect(line).toContain('Difference R 10.00');
    for (const t of ['tile-allocated', 'tile-suggested', 'tile-unallocated', 'tile-excluded', 'tile-awaiting-review']) {
      expect(screen.getByTestId('bank-summary-line').contains(screen.getByTestId(t))).toBe(true);
    }
  });

  it('the full statement panel is behind "Details", collapsed by default', () => {
    render(strip());
    const details = screen.getByRole('button', { name: 'Details' });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('bank-statement-panel')).toBeNull();
    fireEvent.click(details);
    expect(details).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('bank-statement-panel')).toBeInTheDocument();
    fireEvent.click(details);
    expect(screen.queryByTestId('bank-statement-panel')).toBeNull();
  });

  it('a missing statement figure still says why, never a bare dash', () => {
    render(strip({ bank: summaryAcct('a1', { counts, statement: { latest: ref({ closingCents: null, openingCents: null, balanceSource: 'not_in_file' }) } }) }));
    const stmt = screen.getByTestId('summary-statement');
    expect(stmt.textContent).toBe('Statement not available');
    expect(stmt.getAttribute('title')).toBe('Not provided by this file format');
    expect(screen.queryByTestId('summary-difference')).toBeNull();
    render(strip({ bank: summaryAcct('a2', { counts }) }));
    expect(screen.getAllByTestId('summary-statement')[1]!.textContent).toBe('No statement imported');
  });

  it('an unchecked closing balance: the difference says "(not checked)" and is never styled as reconciled', () => {
    const l = ref({ balanceSource: 'ai_read' });
    render(strip({ bank: summaryAcct('a1', { counts, statement: { latest: l, lastWithBalance: l, ledgerAtStatementCents: 250000, differenceCents: 0 } }) }));
    const diff = screen.getByTestId('summary-difference');
    expect(flat(diff.textContent)).toBe('Difference (not checked) R 0.00');
    expect(diff.innerHTML).not.toContain('text-teal');
  });
});

describe('the tiles are filter toggles', () => {
  it('status tiles are buttons with aria-pressed reflecting the status filter, and carry their count', () => {
    render(strip({ allocationFilter: 'suggested' }));
    for (const [id, n] of [['tile-allocated', 9], ['tile-suggested', 4], ['tile-unallocated', 5], ['tile-excluded', 2]] as const) {
      const t = screen.getByTestId(id);
      expect(t.tagName).toBe('BUTTON');
      expect(t.getAttribute('data-count')).toBe(String(n));
    }
    expect(screen.getByTestId('tile-suggested')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('tile-unallocated')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('tile-excluded')).toHaveAttribute('aria-pressed', 'false');
  });

  it('the four status tiles still sum to data-posted-lines', () => {
    render(strip());
    const sum = ['tile-allocated', 'tile-suggested', 'tile-unallocated', 'tile-excluded']
      .map(id => Number(screen.getByTestId(id).getAttribute('data-count'))).reduce((a, b) => a + b, 0);
    expect(sum).toBe(Number(screen.getByTestId('bank-tx-stats-strip').getAttribute('data-posted-lines')));
  });

  it('a click reports the tile; the Excluded tile is pressed on the Excluded tab', () => {
    const onTile = vi.fn();
    render(strip({ onTile, tab: 'excluded' }));
    expect(screen.getByTestId('tile-excluded')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('tile-unallocated'));
    fireEvent.click(screen.getByTestId('tile-excluded'));
    expect(onTile.mock.calls).toEqual([['unallocated'], ['excluded']]);
  });

  it('a status tile is pressed only on the New tab (the status filter is that tab\'s)', () => {
    render(strip({ tab: 'reviewed', allocationFilter: 'allocated' }));
    expect(screen.getByTestId('tile-allocated')).toHaveAttribute('aria-pressed', 'false');
  });

  it('the figures are the whole account\'s, and say so; a pressed tile adds how many lines the list holds', () => {
    const { rerender } = render(strip({ allocationFilter: 'suggested', shown: 3 }));
    expect(screen.getByTestId('tile-unallocated')).toHaveAccessibleName('5 Unallocated on this account (all tabs)');
    expect(screen.getByTestId('tile-unallocated').getAttribute('title')).toMatch(/^5 unallocated on this account, all tabs\./);
    expect(screen.getByTestId('tile-suggested')).toHaveAccessibleName('4 Suggested on this account (all tabs), 3 in the list');
    expect(screen.getByTestId('tile-in-list').textContent).toBe('· 3 in the list');
    rerender(strip({ allocationFilter: 'suggested', shown: null }));
    expect(screen.queryByTestId('tile-in-list')).toBeNull();
  });

  it('awaiting review is a figure, not a toggle; "incl. n provisional" is its own button', () => {
    const onShowProvisional = vi.fn();
    render(strip({ onShowProvisional }));
    expect(screen.getByTestId('tile-awaiting-review').tagName).not.toBe('BUTTON');
    expect(screen.getByTestId('tile-awaiting-review').getAttribute('data-count')).toBe('11');
    const link = screen.getByTestId('tile-provisional-link');
    expect(screen.getByTestId('tile-allocated').contains(link)).toBe(false); // no button inside a button
    fireEvent.click(link);
    expect(onShowProvisional).toHaveBeenCalledTimes(1);
  });
});

describe('statusTileClick: what a tile does to the view', () => {
  it('a status tile sets that status filter on the New tab (where the filter and the lines to code are)', () => {
    expect(statusTileClick({ tab: 'new', allocationFilter: 'all' }, 'suggested')).toEqual({ tab: 'new', allocationFilter: 'suggested' });
    expect(statusTileClick({ tab: 'reviewed', allocationFilter: 'all' }, 'unallocated')).toEqual({ tab: 'new', allocationFilter: 'unallocated' });
  });
  it('statusTilePressed: never on another tab, even with the filter set', () => {
    expect(statusTilePressed({ tab: 'reviewed', allocationFilter: 'allocated' }, 'allocated')).toBe(false);
    expect(statusTilePressed({ tab: 'new', allocationFilter: 'allocated' }, 'allocated')).toBe(true);
    expect(statusTilePressed({ tab: 'excluded', allocationFilter: 'all' }, 'excluded')).toBe(true);
  });
  it('pressing the pressed tile drops the filter and stays where it is', () => {
    expect(statusTileClick({ tab: 'new', allocationFilter: 'suggested' }, 'suggested')).toEqual({ tab: 'new', allocationFilter: 'all' });
    expect(statusTileClick({ tab: 'reviewed', allocationFilter: 'allocated' }, 'allocated')).toEqual({ tab: 'reviewed', allocationFilter: 'all' });
  });
  it('Excluded toggles the Excluded tab', () => {
    expect(statusTileClick({ tab: 'new', allocationFilter: 'suggested' }, 'excluded')).toEqual({ tab: 'excluded', allocationFilter: 'all' });
    expect(statusTileClick({ tab: 'excluded', allocationFilter: 'all' }, 'excluded')).toEqual({ tab: 'new', allocationFilter: 'all' });
  });
});
