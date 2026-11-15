/**
 * The Δ on a bank card is `unreconciledBalance`: the net of posted lines with NO journal line, not excluded. Its
 * tooltip counts those same lines — suggested + unallocated, as the board pack pairs them — and never
 * `unreconciledCount`, which since #1442 means "not reconciled" (journal or not) for the export and MCP.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BankPrimaryCard } from '@/components/accounting/bank-transactions/BankPrimaryCard';
import { BankGroupCard } from '@/components/accounting/bank-transactions/BankSubAccountGroup';
import { groupBankAccounts } from '@/components/accounting/bank-transactions/groupBankAccounts';
import type { BankAcct } from '@/components/accounting/bank-transactions/BankTxBankCards';

afterEach(cleanup);

const acct = (over: Partial<BankAcct>): BankAcct => ({
  id: 'a1', accountCode: '1110', accountName: 'Cheque', balance: 1000, reconciledBalance: 400,
  unreconciledBalance: -250, unreconciledCount: 99, allocatedCount: 40, suggestedCount: 2, unallocatedCount: 3,
  ...over,
});
const noop = () => undefined;

describe('bank card Δ tooltip', () => {
  it('a primary card counts the suggested + unallocated lines behind Δ, not unreconciledCount', () => {
    render(<BankPrimaryCard b={acct({})} active={false} onSelect={noop} />);
    expect(screen.getByText(/Δ/).closest('[title]')?.getAttribute('title')).toBe('5 unallocated transactions');
  });

  it('a missing suggestedCount counts as none, and one line is singular', () => {
    render(<BankPrimaryCard b={acct({ suggestedCount: undefined, unallocatedCount: 1 })} active={false} onSelect={noop} />);
    expect(screen.getByText(/Δ/).closest('[title]')?.getAttribute('title')).toBe('1 unallocated transaction');
  });

  it('a group card sums the same lines across its sub-accounts', () => {
    const { groups } = groupBankAccounts([
      acct({ id: 's1', groupId: 'g', groupName: 'Paycards' }),
      acct({ id: 's2', groupId: 'g', groupName: 'Paycards', suggestedCount: 0, unallocatedCount: 4, unreconciledCount: 7 }),
    ]);
    render(<BankGroupCard group={groups[0]!} containsSelection={false} expanded={false} onToggle={noop}
      resume={null} onResume={noop} />);
    expect(screen.getByText(/Δ/).closest('[title]')?.getAttribute('title'))
      .toBe('9 unallocated transactions across this group');
  });
});
