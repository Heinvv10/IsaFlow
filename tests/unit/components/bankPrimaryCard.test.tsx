/**
 * The bank card's figures (WP1 PR-C): a labelled ledger balance, "N to code · in R… / out −R…", no glyph-only numbers.
 * The warning keys on the COUNT of lines still to code, never on a net amount: +R100 and −R100 net to R0.00 and are
 * still two lines to code.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BankPrimaryCard } from '@/components/accounting/bank-transactions/BankPrimaryCard';
import { BankGroupCard } from '@/components/accounting/bank-transactions/BankSubAccountGroup';
import { groupBankAccounts } from '@/components/accounting/bank-transactions/groupBankAccounts';
import { summaryAcct } from '../helpers/bankSummaryFixture';

afterEach(cleanup);
const noop = () => undefined;
const nbsp = (s: string) => s.replace(/ /g, ' ');

describe('BankPrimaryCard', () => {
  it('labels the ledger figure and says what is to code, in and out', () => {
    render(<BankPrimaryCard b={summaryAcct('a', { accountName: 'Cheque', ledgerCents: 123456,
      counts: { suggested: 1, unallocated: 2 }, toCodeInCents: 25025, toCodeOutCents: -10010 })} active={false} onSelect={noop} />);
    expect(nbsp(screen.getByTestId('card-ledger').textContent!)).toBe('Ledger R 1 234.56');
    expect(screen.getByTestId('card-ledger').getAttribute('title')).toBe('Ledger balance as at 2026-11-16');
    expect(nbsp(screen.getByTestId('card-to-code').textContent!)).toBe('3 to code · in R 250.25 / out −R 100.10');
  });

  it('warns on a COUNT: lines that net to R0.00 still read "2 to code"', () => {
    render(<BankPrimaryCard b={summaryAcct('a', { counts: { unallocated: 2 }, toCodeInCents: 10000, toCodeOutCents: -10000 })}
      active={false} onSelect={noop} />);
    expect(screen.getByTestId('card-to-code').textContent).toMatch(/^2 to code/);
    expect(screen.queryByTestId('card-all-coded')).toBeNull();
  });

  it('nothing to code reads "All coded", whatever the in/out say', () => {
    render(<BankPrimaryCard b={summaryAcct('a', { toCodeInCents: 5000, toCodeOutCents: -5000 })} active={false} onSelect={noop} />);
    expect(screen.getByTestId('card-all-coded').textContent).toBe('All coded');
    expect(screen.queryByTestId('card-to-code')).toBeNull();
  });

  it('has no glyph-only figure: no check mark, no delta sign', () => {
    render(<BankPrimaryCard b={summaryAcct('a', { ledgerCents: 100, counts: { unallocated: 1 } })} active={false} onSelect={noop} />);
    expect(screen.getByTestId('bank-account-card').textContent).not.toMatch(/[✓Δ]/);
  });

  it('an inactive account is muted and carries an Inactive chip', () => {
    render(<BankPrimaryCard b={summaryAcct('a', { isActive: false, ledgerCents: 100 })} active={false} onSelect={noop} />);
    expect(screen.getByTestId('card-inactive-chip').textContent).toBe('Inactive');
    expect(screen.getByTestId('bank-account-card').className).toContain('opacity-70');
  });

  it('an active account has no chip', () => {
    render(<BankPrimaryCard b={summaryAcct('a')} active={false} onSelect={noop} />);
    expect(screen.queryByTestId('card-inactive-chip')).toBeNull();
  });
});

describe('BankGroupCard', () => {
  it('sums its members: integer-cent ledger, to-code lines and in/out', () => {
    const { groups } = groupBankAccounts([
      summaryAcct('s1', { groupId: 'g', groupName: 'Paycards', ledgerCents: 10, counts: { suggested: 1, unallocated: 2 }, toCodeInCents: 100, toCodeOutCents: -50 }),
      summaryAcct('s2', { groupId: 'g', groupName: 'Paycards', ledgerCents: 20, counts: { unallocated: 4 }, toCodeInCents: 0, toCodeOutCents: -250 }),
    ]);
    render(<BankGroupCard group={groups[0]!} containsSelection={false} expanded={false} onToggle={noop} resume={null} onResume={noop} />);
    expect(nbsp(screen.getByTestId('card-ledger').textContent!)).toBe('Ledger R 0.30');
    expect(nbsp(screen.getByTestId('card-to-code').textContent!)).toBe('7 to code · in R 1.00 / out −R 3.00');
    // One line on the card (cut when long, WP4b): the tooltip carries the amounts too.
    expect(nbsp(screen.getByTestId('card-to-code').getAttribute('title')!)).toBe('7 lines still to code across this group (in R 1.00 / out −R 3.00)');
    expect(screen.getByTestId('card-to-code').className).toContain('truncate');
  });

  it('a group with nothing to code reads "All coded"', () => {
    const { groups } = groupBankAccounts([summaryAcct('s1', { groupId: 'g', groupName: 'Paycards' })]);
    render(<BankGroupCard group={groups[0]!} containsSelection={false} expanded={false} onToggle={noop} resume={null} onResume={noop} />);
    expect(screen.getByTestId('card-all-coded')).toBeTruthy();
  });
});
