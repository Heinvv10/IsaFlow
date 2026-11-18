/** Accepting the last row removes the grid that held the focus: the empty state takes it, not <body>. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BankTxListFrame } from '@/components/accounting/bank-transactions/BankTxListFrame';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
afterEach(cleanup);

const frame = (over: Record<string, unknown>) => (
  <BankTxListFrame relinkFailed={false} aiPolling={0} isLoading={false} error="" empty={false} pastEnd={false} tab="new" activeFilters={[]}
    detailTx={undefined} onDetailClose={() => undefined} {...over}><button>row</button></BankTxListFrame>
);

describe('BankTxListFrame focus', () => {
  it('moves focus to the frame when the list that held rows becomes empty', () => {
    const { rerender } = render(frame({}));
    (screen.getByText('row') as HTMLElement).focus();
    (document.activeElement as HTMLElement).blur(); // the focused row unmounts: focus is on <body>
    rerender(frame({ empty: true }));
    expect(document.activeElement).toBe(screen.getByTestId('bank-tx-list-frame'));
  });

  it('does not take focus on a first load that is empty', () => {
    render(frame({ empty: true }));
    expect(document.activeElement).toBe(document.body);
  });

  it('leaves focus alone when it is on something else', () => {
    const { rerender } = render(<><input aria-label="elsewhere" />{frame({})}</>);
    rerender(<><input aria-label="elsewhere" />{frame({ empty: true })}</>);
    screen.getByLabelText('elsewhere').focus();
    rerender(<><input aria-label="elsewhere" />{frame({ empty: true })}</>);
    expect(document.activeElement).toBe(screen.getByLabelText('elsewhere'));
  });
});
