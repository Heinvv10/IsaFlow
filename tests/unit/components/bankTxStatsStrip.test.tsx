/**
 * The tiles (WP1 PR-C): Allocated (incl. n provisional, a link to the Provisional tab), Suggested, Unallocated,
 * Excluded sum to the strip's data-posted-lines; "Awaiting review" is a separate outlined tile with "n shown" and
 * "+n pending at bank". The Provisional tab appears while the account has provisional lines.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BankTxStatsStrip } from '@/components/accounting/bank-transactions/BankTxStatsStrip';
import { BankTxTabs } from '@/components/accounting/bank-transactions/BankTxTabs';
import { tabToStatus } from '@/components/accounting/bank-transactions/bankTxQuery';
import { summaryAcct } from '../helpers/bankSummaryFixture';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
afterEach(cleanup);
const n = (id: string) => Number(screen.getByTestId(id).querySelector('p')!.textContent);
const counts = { posted: 20, allocated: 9, provisional: 2, suggested: 4, unallocated: 5, excluded: 2, awaitingReview: 11, pendingAtBank: 3 };

describe('BankTxStatsStrip', () => {
  it('four tiles sum to data-posted-lines; awaiting review is not one of them', () => {
    render(<BankTxStatsStrip bank={summaryAcct('a', { counts })} shown={null} onShowProvisional={vi.fn()} />);
    const sum = ['tile-allocated', 'tile-suggested', 'tile-unallocated', 'tile-excluded'].map(n).reduce((a, b) => a + b, 0);
    expect(sum).toBe(20);
    expect(Number(screen.getByTestId('bank-tx-stats-strip').getAttribute('data-posted-lines'))).toBe(sum);
    expect(n('tile-awaiting-review')).toBe(11);
  });

  it('awaiting review is an outlined tile; "n shown" only while filters narrow the New tab; "+n pending at bank" only when pending', () => {
    const { rerender } = render(<BankTxStatsStrip bank={summaryAcct('a', { counts })} shown={4} onShowProvisional={vi.fn()} />);
    expect(screen.getByTestId('tile-awaiting-review').className).toContain('border-dashed');
    // The list also carries the lines pending at the bank, which the tile does not count: say so.
    expect(screen.getByTestId('tile-awaiting-shown').textContent).toBe('4 shown (incl. pending at bank)');
    expect(screen.getByTestId('tile-pending-at-bank').textContent).toBe('+3 pending at bank');
    rerender(<BankTxStatsStrip bank={summaryAcct('a', { counts: { ...counts, pendingAtBank: 0 } })} shown={4} onShowProvisional={vi.fn()} />);
    expect(screen.getByTestId('tile-awaiting-shown').textContent).toBe('4 shown'); // nothing pending: plain
    rerender(<BankTxStatsStrip bank={summaryAcct('a', { counts: { ...counts, pendingAtBank: 0 } })} shown={null} onShowProvisional={vi.fn()} />);
    expect(screen.queryByTestId('tile-awaiting-shown')).toBeNull();
    expect(screen.queryByTestId('tile-pending-at-bank')).toBeNull();
  });

  it('"incl. n provisional" is a button that opens the Provisional tab', () => {
    const onShowProvisional = vi.fn();
    render(<BankTxStatsStrip bank={summaryAcct('a', { counts })} shown={null} onShowProvisional={onShowProvisional} />);
    const link = screen.getByTestId('tile-provisional-link');
    expect(link.textContent).toBe('incl. 2 provisional');
    fireEvent.click(link);
    expect(onShowProvisional).toHaveBeenCalledTimes(1);
  });

  it('no provisional lines: no provisional link', () => {
    render(<BankTxStatsStrip bank={summaryAcct('a', { counts: { ...counts, provisional: 0 } })} shown={null} onShowProvisional={vi.fn()} />);
    expect(screen.queryByTestId('tile-provisional-link')).toBeNull();
  });
});

describe('BankTxTabs: the Provisional tab', () => {
  it('is absent without provisional lines, present with them (with the count), and always while open', () => {
    const { rerender } = render(<BankTxTabs tab="new" onTab={vi.fn()} provisionalCount={0} />);
    expect(screen.queryByTestId('bank-tx-tab-provisional')).toBeNull();
    rerender(<BankTxTabs tab="new" onTab={vi.fn()} provisionalCount={2} />);
    expect(screen.getByTestId('bank-tx-tab-provisional').textContent).toBe('Provisional (2)');
    rerender(<BankTxTabs tab="provisional" onTab={vi.fn()} provisionalCount={0} />);
    expect(screen.getByTestId('bank-tx-tab-provisional').getAttribute('aria-current')).toBe('page');
  });

  it('clicking it asks for the provisional tab, which the list requests as status=provisional', () => {
    const onTab = vi.fn();
    render(<BankTxTabs tab="new" onTab={onTab} provisionalCount={1} />);
    fireEvent.click(screen.getByTestId('bank-tx-tab-provisional'));
    expect(onTab).toHaveBeenCalledWith('provisional');
    expect(tabToStatus('provisional')).toBe('provisional');
  });
});
