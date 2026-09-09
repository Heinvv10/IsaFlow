/**
 * K-020: the reconciliation header must show the GL balance, and must say so
 * when the stored reconciled_balance is a pre-fix figure that no longer agrees
 * with it. Rendered, not grepped: both are conditionals inside the tile.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { ReconciliationBalances } from '@/components/accounting/bank/ReconciliationBalances';
import { formatCurrency } from '@/utils/formatters';
import type { BankReconciliation } from '@/modules/accounting/types/bank.types';

const recon = (over: Partial<BankReconciliation> = {}): BankReconciliation => ({
  id: 'r1', bankAccountId: 'b1', statementDate: '2026-03-31',
  statementBalance: 1050, glBalance: 1050, reconciledBalance: 1050, difference: 0,
  status: 'in_progress', startedBy: 'u1', startedAt: '2026-03-31T00:00:00Z',
  createdAt: '2026-03-31T00:00:00Z', updatedAt: '2026-03-31T00:00:00Z',
  ...over,
} as BankReconciliation);

describe('ReconciliationBalances', () => {
  it('shows the GL balance once and no legacy warning when the columns agree', () => {
    render(<ReconciliationBalances recon={recon()} />);
    expect(screen.getByText('GL Balance (as at statement date)')).toBeDefined();
    expect(screen.queryByText(/predates the balance/)).toBeNull();
    // The removed "Reconciled Balance" tile must not come back: one figure, one tile.
    expect(screen.queryByText('Reconciled Balance')).toBeNull();
    expect(screen.getByText('Balanced')).toBeDefined();
  });

  it('warns, and still shows the GL figure, on a pre-fix row where the columns differ', () => {
    // The defect's own shape: gl_balance 1000, reconciled_balance 1000 + 1000 matched.
    render(<ReconciliationBalances recon={recon({
      glBalance: 1000, reconciledBalance: 2000, difference: -950,
    })} />);
    expect(screen.getByText(/predates the balance/)).toBeDefined();
    const tile = screen.getByText('GL Balance (as at statement date)').parentElement!;
    // Compare against the same formatter the tile uses: the SA locale's group
    // separator is not a comma.
    expect(tile.textContent).toContain(formatCurrency(1000));
    expect(tile.textContent).toContain(formatCurrency(2000));
    expect(screen.queryByText('Balanced')).toBeNull();
  });
});
