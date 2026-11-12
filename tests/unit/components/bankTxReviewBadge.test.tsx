/**
 * The review / reconciliation chip on a bank line (migration 980): reconciled lines link to their
 * reconciliation, Sage-reconciled ones say so, reviewed ones say who reviewed them.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { BankTxReviewBadge } from '@/components/accounting/bankTx/BankTxReviewBadge';
import type { BankTx } from '@/components/accounting/bankTx/bankTxTypes';

const tx = (over: Partial<BankTx>): BankTx => ({ id: 't', transactionDate: '2026-06-01', amount: 10, status: 'matched', ...over });

describe('BankTxReviewBadge', () => {
  it('a reconciled line links to its reconciliation with the statement date and the reviewer', () => {
    render(<BankTxReviewBadge tx={tx({ status: 'reconciled', reconciliationId: 'r1', reconStatementDate: '2026-06-30',
      reviewedAt: '2026-06-28T10:15:00+02:00', reviewedByName: 'Ann Clerk' })} />);
    const link = screen.getByRole('link', { name: 'Reconciled · 30 Jun 2026' });
    expect(link).toHaveAttribute('href', '/accounting/bank-reconciliation/r1');
    expect(link).toHaveAttribute('title', expect.stringMatching(/^Reviewed 28 Jun 2026, \d\d:\d\d by Ann Clerk$/));
  });

  it('a Sage-reconciled line (no reconciliation) is labelled, not linked; unknown reviewer is said', () => {
    render(<BankTxReviewBadge tx={tx({ status: 'reconciled', reviewedAt: '2026-04-19T18:57:00+02:00' })} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Reconciled (Sage)')).toHaveAttribute('title', expect.stringMatching(/by reviewer unknown$/));
  });

  it('a reviewed, unreconciled line reads Reviewed; an unreviewed one shows nothing', () => {
    const { container, rerender } = render(<BankTxReviewBadge tx={tx({ reviewedAt: '2026-06-02T09:00:00+02:00', reviewedByName: 'Bo' })} />);
    expect(screen.getByText('Reviewed')).toHaveAttribute('title', expect.stringMatching(/by Bo$/));
    rerender(<BankTxReviewBadge tx={tx({})} />);
    expect(container).toBeEmptyDOMElement();
  });
});
