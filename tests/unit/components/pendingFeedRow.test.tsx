import { describe, expect, it } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { actionableIds, isPendingFeedRow, PendingFeedBadge, PendingFeedNotice } from '@/components/accounting/bank-transactions/pendingFeedRow';

describe('pending feed rows', () => {
  it('recognises pending rows only', () => {
    expect(isPendingFeedRow({ feedState: 'pending' })).toBe(true);
    expect(isPendingFeedRow({ feedState: 'posted' })).toBe(false);
    expect(isPendingFeedRow({})).toBe(false);
  });
  it('drops pending rows from a bulk selection', () => {
    const txs = [{ id: 'a', feedState: 'posted' }, { id: 'b', feedState: 'pending' }, { id: 'c' }];
    expect(actionableIds(txs, ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });
  it('renders the badge and the explanation', () => {
    render(<><PendingFeedBadge /><PendingFeedNotice /></>);
    expect(screen.getByText('Pending')).toBeTruthy();
    expect(screen.getByText(/actions unlock once it posts/)).toBeTruthy();
  });
});
