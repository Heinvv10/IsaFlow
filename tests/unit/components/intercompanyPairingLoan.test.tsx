// Intercompany P3: the loan-balance card. Net debit: a receivable is positive (Dr), a payable negative (Cr). The two companies' loan
// accounts mirror each other, so the difference is yours + theirs; every expected sentence below is worked out from the figures.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LoanDifferenceCard } from '@/components/accounting/intercompany/pairing/LoanDifferenceCard';
import type { LoanDifference } from '@/modules/accounting/services/intercompany/pairingTypes';

const card = (mine: number, theirs: number | null) => {
  const difference = theirs === null ? null : Math.round((mine + theirs) * 100) / 100;
  const loan: LoanDifference = { mine, theirs, difference, asAt: '2026-09-30' };
  render(<LoanDifferenceCard loan={loan} partnerName="Velocity Fibre" />);
};

describe('LoanDifferenceCard', () => {
  it('shows each balance as Dr / Cr and the day the balances are as at', () => {
    card(5000, -4800);
    expect(screen.getByTestId('loan-mine')).toHaveTextContent('R 5 000.00 Dr');
    expect(screen.getByTestId('loan-theirs')).toHaveTextContent('R 4 800.00 Cr');
    expect(screen.getByTestId('loan-difference')).toHaveTextContent('30 Sep 2026');
  });

  it('above nil (you Dr 5 000, they Cr 4 800): you show R 200 more owed to you than they show owing', () => {
    card(5000, -4800);
    expect(screen.getByTestId('loan-difference-value')).toHaveAttribute('data-state', 'differs');
    expect(screen.getByTestId('loan-higher')).toHaveTextContent("Your books show R 200.00 more owed to you (or less owed by you) than Velocity Fibre's");
  });

  it('below nil (you Dr 4 800, they Cr 5 000): they show owing R 200 more than you show owed to you', () => {
    card(4800, -5000);
    expect(screen.getByTestId('loan-difference-value')).toHaveAttribute('data-state', 'differs');
    expect(screen.getByTestId('loan-difference-value')).toHaveTextContent('R 200.00');
    expect(screen.getByTestId('loan-higher')).toHaveTextContent("Velocity Fibre's books show R 200.00 more owed by them (or less owed to them) than yours");
  });

  it('below nil the other way round (you Cr 1 000 owed by you, they Dr 900 owed to them): they claim R 100 less than you owe', () => {
    card(-1000, 900);
    expect(screen.getByTestId('loan-higher')).toHaveTextContent("Velocity Fibre's books show R 100.00 more owed by them (or less owed to them) than yours");
  });

  it('at nil (you Dr 5 000, they Cr 5 000) the balances agree and no side is named', () => {
    card(5000, -5000);
    expect(screen.getByTestId('loan-difference-value')).toHaveAttribute('data-state', 'agrees');
    expect(screen.getByTestId('loan-difference-value')).toHaveTextContent('None: the balances agree');
    expect(screen.queryByTestId('loan-higher')).toBeNull();
  });

  it('with no partner figure the difference is unknown, says why, and names no side', () => {
    card(100, null);
    expect(screen.getByTestId('loan-difference-value')).toHaveAttribute('data-state', 'unknown');
    expect(screen.getByTestId('loan-theirs')).toHaveTextContent('Not available');
    expect(screen.getByTestId('loan-difference')).toHaveTextContent(/has not set a loan account/);
    expect(screen.queryByTestId('loan-higher')).toBeNull();
  });
});
