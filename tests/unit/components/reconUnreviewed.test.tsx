/**
 * The bank reconciliation screen names the matched lines nobody has reviewed (migration 980): completion refuses
 * while any remain, and Review lives on the Bank Transactions New tab.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { isUnreviewedMatch, NotReviewedChip, ReconUnreviewedNotice } from '@/components/accounting/bank/ReconUnreviewed';
import type { BankTransaction } from '@/modules/accounting/types/bank.types';

const tx = (over: Partial<BankTransaction>) => ({ id: 't', status: 'matched', ...over }) as BankTransaction;

describe('ReconUnreviewed', () => {
  it('a matched or allocated line with no review stamp is unreviewed; a reviewed or reconciled one is not', () => {
    expect([tx({}), tx({ status: 'allocated' }), tx({ reviewedAt: '2026-06-01T00:00:00Z' }), tx({ status: 'reconciled' })]
      .map(isUnreviewedMatch)).toEqual([true, true, false, false]);
  });

  it('says how many and links to the bank account\'s transactions; renders nothing at zero', () => {
    const matched = [tx({ id: 'a' }), tx({ id: 'b', status: 'allocated' }), tx({ id: 'c', reviewedAt: '2026-06-01T00:00:00Z' })];
    const { container, rerender } = render(<ReconUnreviewedNotice matched={matched} completed={false} bankAccountId="b1" />);
    expect(container).toHaveTextContent('2 matched transactions are not reviewed yet');
    expect(screen.getByRole('link', { name: 'Bank Transactions' })).toHaveAttribute('href', '/accounting/bank-transactions?account_id=b1');
    rerender(<ReconUnreviewedNotice matched={matched} completed bankAccountId="b1" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ReconUnreviewedNotice matched={[matched[2]!]} completed={false} bankAccountId="b1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('the chip shows on an unreviewed line of an open reconciliation only', () => {
    const { container, rerender } = render(<NotReviewedChip tx={tx({})} completed={false} />);
    expect(container).toHaveTextContent('Not reviewed');
    rerender(<NotReviewedChip tx={tx({})} completed />);
    expect(container).toBeEmptyDOMElement();
    rerender(<NotReviewedChip tx={tx({ reviewedAt: '2026-06-01T00:00:00Z' })} completed={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
