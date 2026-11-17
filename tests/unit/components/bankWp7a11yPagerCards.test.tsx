/**
 * WP7 accessibility: the pager is a named `nav` with aria-current on the current page; no state is colour-only: the
 * selected account card and group card and worklist row carry a check mark, the selected tab is bolder (and underlined).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BankTxPagination } from '@/components/accounting/bank-transactions/BankTxPagination';
import { BankTxTabs } from '@/components/accounting/bank-transactions/BankTxTabs';
import { BankPrimaryCard } from '@/components/accounting/bank-transactions/BankPrimaryCard';
import { BankGroupCard } from '@/components/accounting/bank-transactions/BankSubAccountGroup';
import { summaryAcct } from '../helpers/bankSummaryFixture';
import { BankGroupWorklist } from '@/components/accounting/bank-transactions/BankGroupWorklist';
import type { BankAccountGroup } from '@/components/accounting/bank-transactions/groupBankAccounts';

afterEach(cleanup);

describe('pager', () => {
  it('is a navigation named "Transaction pages"; exactly the current page has aria-current="page"', () => {
    render(<BankTxPagination page={3} total={200} pageSize={25} onPage={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: 'Transaction pages' });
    const current = nav.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toBe('3');
  });
  it('the mark follows the page, and a click still pages', () => {
    const onPage = vi.fn();
    const { rerender } = render(<BankTxPagination page={1} total={200} pageSize={25} onPage={onPage} />);
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(onPage).toHaveBeenCalledWith(2);
    rerender(<BankTxPagination page={2} total={200} pageSize={25} onPage={onPage} />);
    expect(screen.getByRole('button', { name: '2' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: '1' }).getAttribute('aria-current')).toBeNull();
  });
});

describe('no colour-only state', () => {
  it('the selected account card shows a check; an unselected one does not', () => {
    const b = summaryAcct('a');
    const { rerender } = render(<BankPrimaryCard b={b} active onSelect={vi.fn()} />);
    expect(screen.getByTestId('card-selected-mark')).toBeTruthy();
    rerender(<BankPrimaryCard b={b} active={false} onSelect={vi.fn()} />);
    expect(screen.queryByTestId('card-selected-mark')).toBeNull();
  });
  it('a group card shows the check when it holds the selection', () => {
    const group = { groupId: 'g', groupName: 'Paycards', groupCode: null, accounts: [summaryAcct('s1')], ledgerCents: 0, toCode: 0, toCodeInCents: 0, toCodeOutCents: 0, allocated: 0, suggested: 0, unallocated: 0 } as BankAccountGroup;
    const { rerender } = render(<BankGroupCard group={group} containsSelection expanded={false} onToggle={vi.fn()} resume={null} onResume={vi.fn()} />);
    expect(screen.getByTestId('card-selected-mark')).toBeTruthy();
    rerender(<BankGroupCard group={group} containsSelection={false} expanded onToggle={vi.fn()} resume={null} onResume={vi.fn()} />);
    expect(screen.queryByTestId('card-selected-mark')).toBeNull(); // expanded only: colour, but no selection to mark
  });
  it('the selected row of a group worklist shows a check', () => {
    const group = { groupId: 'g', groupName: 'Paycards', groupCode: null, accounts: [summaryAcct('s1'), summaryAcct('s2')], ledgerCents: 0, toCode: 0, toCodeInCents: 0, toCodeOutCents: 0, allocated: 0, suggested: 0, unallocated: 0 } as BankAccountGroup;
    render(<BankGroupWorklist group={group} selectedBank="s2" onSelectBank={vi.fn()} />);
    const marks = screen.getAllByTestId('row-selected-mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.closest('[data-testid="bank-group-row"]')!.textContent).toContain('Account s2');
  });
  it('the selected tab is semibold (shape/weight), the others medium', () => {
    render(<BankTxTabs tab="reviewed" onTab={vi.fn()} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map(t => t.className.includes('font-semibold'))).toEqual([false, true, false]);
    expect(tabs.map(t => t.className.includes('font-medium'))).toEqual([true, false, true]);
  });
});
