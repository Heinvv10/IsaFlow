/**
 * Past-the-end page. Accepting or excluding the last row of the last page reloads that page, which now
 * lies past the end: the API returns no rows and a total above zero. The list then said "No new
 * transactions for this account" while the count beside it said 24. usePageClamp moves to the last page
 * that exists and so refetches once; BankTxListFrame shows the skeleton, not the empty state, while the page
 * is past the end. Only then: an empty page 1 with a stale total above zero still says empty, never a skeleton
 * that nothing will replace.
 */
import { describe, it, expect } from 'vitest';
import React, { useEffect, useState } from 'react';
import { render, screen, act } from '@testing-library/react';
import { bankTxPastEnd, lastPage, usePageClamp } from '@/components/accounting/bank-transactions/usePageClamp';
import { BankTxListFrame } from '@/components/accounting/bank-transactions/BankTxListFrame';
import { BankTxLoading, BANK_TX_FRAME_MIN_PX, BANK_TX_PAGE_SIZE, BANK_TX_ROW_PX } from '@/components/accounting/bank-transactions/BankTxListStates';

describe('lastPage', () => {
  it.each([
    [0, 25, 1], [1, 25, 1], [25, 25, 1], [26, 25, 2], [24, 25, 1], [51, 25, 3],
  ])('total %i at %i a page -> %i', (total, size, want) => {
    expect(lastPage(total, size)).toBe(want);
  });
});

let fetches: number[] = [];
let setTotalOut: (n: number) => void = () => {};
function Harness({ initialPage, initialTotal, loading = false, failed = false }: { initialPage: number; initialTotal: number; loading?: boolean; failed?: boolean }) {
  const [page, setPage] = useState(initialPage);
  const [total, setTotal] = useState(initialTotal);
  setTotalOut = setTotal;
  useEffect(() => { fetches.push(page); }, [page]); // the page's loadTransactions is keyed on page the same way
  usePageClamp({ page, total, pageSize: 25, isLoading: loading, failed, setPage });
  return <div data-testid="page">{page}</div>;
}

describe('usePageClamp', () => {
  it('total 26 -> 24 on page 2 of 25 a page ends on page 1, with one refetch', () => {
    fetches = [];
    render(<Harness initialPage={2} initialTotal={26} />);
    expect(screen.getByTestId('page').textContent).toBe('2');
    expect(fetches).toEqual([2]);
    act(() => setTotalOut(24));
    expect(screen.getByTestId('page').textContent).toBe('1');
    expect(fetches).toEqual([2, 1]);
  });

  it('leaves a page that still exists alone', () => {
    fetches = [];
    render(<Harness initialPage={2} initialTotal={51} />);
    act(() => setTotalOut(50));
    expect(screen.getByTestId('page').textContent).toBe('2');
    expect(fetches).toEqual([2]);
  });

  it('waits while the list is loading: the total is the previous request\'s', () => {
    fetches = [];
    render(<Harness initialPage={3} initialTotal={10} loading />);
    expect(screen.getByTestId('page').textContent).toBe('3');
  });

  it('a failed load (rows and total zeroed) leaves the page alone: the error shows where the user asked', () => {
    fetches = [];
    render(<Harness initialPage={3} initialTotal={0} failed />);
    expect(screen.getByTestId('page').textContent).toBe('3');
    expect(fetches).toEqual([3]);
  });

  it('an empty account goes to page 1', () => {
    fetches = [];
    render(<Harness initialPage={4} initialTotal={0} />);
    expect(screen.getByTestId('page').textContent).toBe('1');
    expect(fetches).toEqual([4, 1]);
  });
});

describe('BankTxListFrame', () => {
  const frame = (empty: boolean, pastEnd: boolean) => render(
    <BankTxListFrame relinkFailed={false} aiPolling={0} isLoading={false} error="" empty={empty} pastEnd={pastEnd} tab="new">
      <div data-testid="rows" />
    </BankTxListFrame>,
  );

  it('no rows on a page past the end (about to be clamped) shows the skeleton, not "empty"', () => {
    frame(true, true);
    expect(screen.queryByTestId('bank-tx-empty')).toBeNull();
    expect(screen.getByTestId('list-skeleton')).toBeInTheDocument();
  });

  it('a failed load on a page that reads as past the end shows the error, not the skeleton', () => {
    render(
      <BankTxListFrame relinkFailed={false} aiPolling={0} isLoading={false} error="Could not load transactions - try again" empty pastEnd tab="new">
        <div data-testid="rows" />
      </BankTxListFrame>,
    );
    expect(screen.getByText('Could not load transactions - try again')).toBeInTheDocument();
    expect(screen.queryByTestId('list-skeleton')).toBeNull();
  });

  it('no rows on a page that exists is empty', () => {
    frame(true, false);
    expect(screen.getByTestId('bank-tx-empty')).toBeInTheDocument();
  });

  it('page 1 with no rows and a stale total above zero says empty: the clamp will not move it, so a skeleton would stick', () => {
    expect(bankTxPastEnd(1, 24, 25)).toBe(false);
    frame(true, bankTxPastEnd(1, 24, 25));
    expect(screen.getByTestId('bank-tx-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('list-skeleton')).toBeNull();
  });

  it.each([[2, 24, true], [2, 26, false], [1, 0, false], [3, 50, true]])('page %i of total %i is past the end: %s', (page, total, want) => {
    expect(bankTxPastEnd(page, total, 25)).toBe(want);
  });

  it('rows render the table', () => {
    frame(false, false);
    expect(screen.getByTestId('rows')).toBeInTheDocument();
  });

  it('holds a full page while loading, so a full page of rows replaces the skeleton without a shift', () => {
    render(
      <BankTxListFrame relinkFailed={false} aiPolling={0} isLoading error="" empty={false} pastEnd={false} tab="new">
        <div data-testid="rows" />
      </BankTxListFrame>,
    );
    expect(screen.getByTestId('bank-tx-list-frame').style.minHeight).toBe(`${BANK_TX_FRAME_MIN_PX}px`);
  });

  it('holds a full page on a past-the-end page too (the skeleton shows there)', () => {
    frame(true, true);
    expect(screen.getByTestId('bank-tx-list-frame').style.minHeight).toBe(`${BANK_TX_FRAME_MIN_PX}px`);
  });

  it('once loaded, fits its rows: a short tab leaves no gap above the pager', () => {
    frame(false, false);
    expect(screen.getByTestId('bank-tx-list-frame').style.minHeight).toBe('');
    frame(true, false);
    expect(screen.getAllByTestId('bank-tx-list-frame')[1]!.style.minHeight).toBe('');
  });
});

describe('BankTxLoading', () => {
  it('draws a full page of rows at the grid row height, inside a frame that holds a full page', () => {
    render(<BankTxLoading />);
    const sk = screen.getByTestId('list-skeleton');
    const rows = Array.from(sk.children).filter(c => c.className.includes('flex'));
    expect(rows).toHaveLength(BANK_TX_PAGE_SIZE);
    for (const r of rows) expect(r.className).toContain(`h-[${BANK_TX_ROW_PX}px]`);
    expect(BANK_TX_FRAME_MIN_PX).toBe(34 + 25 * 41 + 33);
  });
});
