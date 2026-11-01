/** Master plan U (M10): the drawer's open line does not outlive the row: a line that comes back reopens nothing. */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BankTx } from '@/components/accounting/BankTxTable';
import { useBankLineDetail } from '@/components/accounting/bank-transactions/useBankLineDetail';

const A = { id: 'a' } as BankTx;
const B = { id: 'b' } as BankTx;
const hook = () => renderHook(({ rows }) => useBankLineDetail(rows), { initialProps: { rows: [A, B] } });

afterEach(cleanup);

describe('useBankLineDetail', () => {
  it('opens a line of the list and closes it', () => {
    const { result } = hook();
    act(() => result.current.openDetail('b'));
    expect(result.current.detailTx).toBe(B);
    act(() => result.current.closeDetail());
    expect(result.current.detailTx).toBeUndefined();
  });

  it('a line that leaves the list and comes back does not reopen the drawer', () => {
    const { result, rerender } = hook();
    act(() => result.current.openDetail('b'));
    rerender({ rows: [A] });
    expect(result.current.detailTx).toBeUndefined();
    rerender({ rows: [A, B] });
    expect(result.current.detailTx).toBeUndefined();
  });

  it('stays open across a reload that keeps the line', () => {
    const { result, rerender } = hook();
    act(() => result.current.openDetail('b'));
    const reloaded = { ...B, notes: 'changed' };
    rerender({ rows: [A, reloaded] });
    expect(result.current.detailTx).toBe(reloaded);
  });
});
