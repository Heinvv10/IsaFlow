/**
 * The supplier statement's "Balance brought forward" line shows as "Opening balance" with IsaFlow's figure and
 * the opening variance, never as "Missing in IsaFlow" (Hein, 2026-11-07, D1).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MatchStatusCell } from '@/components/accounting/ap/SupplierStatementMatchCell';

const opening = { asAt: '2026-02-04', statementAmount: 102447.53, isaflowBalance: 102000, variance: 447.53 };

describe('MatchStatusCell: the opening-balance line', () => {
  it('shows "Opening balance" with IsaFlow\'s figure and the variance, even over a stale missing_in_isaflow', () => {
    render(<MatchStatusCell line={{ matchConfidence: null, mismatchReason: 'missing_in_isaflow', isOpeningBalance: true }} opening={opening} />);
    expect(screen.getByText('Opening balance')).toBeTruthy();
    expect(screen.queryByText('Missing in IsaFlow')).toBeNull();
    const check = screen.getByTestId('opening-balance-check').textContent ?? '';
    expect(check).toMatch(/IsaFlow R\s?102\s?000\.00/);
    expect(check).toMatch(/variance R\s?447\.53/);
  });

  it('an ordinary unmatched line still says "Missing in IsaFlow"', () => {
    render(<MatchStatusCell line={{ matchConfidence: null, mismatchReason: 'missing_in_isaflow', isOpeningBalance: false }} />);
    expect(screen.getByText('Missing in IsaFlow')).toBeTruthy();
    expect(screen.queryByText('Opening balance')).toBeNull();
  });
});
