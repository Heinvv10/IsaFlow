/** BankTxSummaryNotice: Retry only when there is something to retry (onRetry given); the none-active notice has none. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BankTxSummaryNotice } from '@/components/accounting/bank-transactions/BankTxSummaryNotice';

afterEach(cleanup);

describe('BankTxSummaryNotice', () => {
  it.each(['error', 'stale'] as const)('%s with onRetry shows a working Retry', (kind) => {
    const onRetry = vi.fn();
    render(<BankTxSummaryNotice kind={kind} onRetry={onRetry} />);
    fireEvent.click(screen.getByTestId('bank-summary-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'stale'] as const)('%s without onRetry shows no Retry button (no dead button)', (kind) => {
    render(<BankTxSummaryNotice kind={kind} />);
    expect(screen.queryByTestId('bank-summary-retry')).toBeNull();
  });

  it('none-active needs no onRetry and has no Retry', () => {
    render(<BankTxSummaryNotice kind="none-active" />);
    expect(screen.getByTestId('bank-summary-none-active').textContent).toMatch(/no active bank accounts/);
    expect(screen.queryByTestId('bank-summary-retry')).toBeNull();
  });
});
