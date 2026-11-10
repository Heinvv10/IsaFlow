/**
 * UXB (wave 5): the bank grid's in-flight guard. A second press on a row whose accept / exclude / split is still
 * pending sends nothing; a request that never settles releases its row after 30 s (with a warning); the timers go
 * with the grid; a late settle of a released request cannot unguard a newer one.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { BankTxTable } from '@/components/accounting/BankTxTable';
import { tableProps } from './bankTxTableFixture';
import { log } from '@/lib/logger';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

afterEach(() => { cleanup(); vi.mocked(log.warn).mockClear(); });

const rows = () => Array.from(document.querySelectorAll('tbody tr')) as HTMLElement[];

describe('a pending action', () => {
  it('a second Enter on the same row while its accept is pending sends nothing; after it settles, it can be pressed again', async () => {
    let finish: (ok: boolean) => void = () => undefined;
    const p = tableProps({ onAccept: vi.fn(() => new Promise<boolean>(r => { finish = r; })) });
    render(<BankTxTable {...p} />);
    const rowA = rows()[0]!;
    fireEvent.click(rowA);
    fireEvent.keyDown(rowA, { key: 'Enter' });
    fireEvent.keyDown(rowA, { key: 'Enter' });
    fireEvent.keyDown(rowA, { key: 'Enter' });
    expect(p.onAccept).toHaveBeenCalledTimes(1);
    await act(async () => { finish(false); await Promise.resolve(); });
    fireEvent.keyDown(rowA, { key: 'Enter' });
    expect(p.onAccept).toHaveBeenCalledTimes(2);
  });
});

describe('a pending action that never settles', () => {
  it('releases its row after 30 s, with a warning', async () => {
    vi.useFakeTimers();
    try {
      const p = tableProps({ onAccept: vi.fn(() => new Promise<boolean>(() => undefined)) });
      render(<BankTxTable {...p} />);
      const rowA = rows()[0]!;
      fireEvent.click(rowA);
      fireEvent.keyDown(rowA, { key: 'Enter' });
      fireEvent.keyDown(rowA, { key: 'Enter' });
      expect(p.onAccept).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(29_999); });
      fireEvent.keyDown(rowA, { key: 'Enter' });
      expect(p.onAccept).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(rowA, { key: 'Enter' });
      expect(p.onAccept).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});

describe('the in-flight guard\'s timers', () => {
  it('are cleared on unmount: no warning 30 s later', async () => {
    vi.useFakeTimers();
    try {
      const p = tableProps({ onAccept: vi.fn(() => new Promise<boolean>(() => undefined)) });
      const { unmount } = render(<BankTxTable {...p} />);
      const rowA = rows()[0]!;
      fireEvent.click(rowA);
      fireEvent.keyDown(rowA, { key: 'Enter' });
      unmount();
      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('a late settle of a released request does not unguard the newer one', async () => {
    vi.useFakeTimers();
    try {
      const settle: Array<(ok: boolean) => void> = [];
      const p = tableProps({ onAccept: vi.fn(() => new Promise<boolean>(r => { settle.push(r); })) });
      render(<BankTxTable {...p} />);
      const rowA = rows()[0]!;
      fireEvent.click(rowA);
      fireEvent.keyDown(rowA, { key: 'Enter' });
      await act(async () => { vi.advanceTimersByTime(30_000); }); // released
      fireEvent.keyDown(rowA, { key: 'Enter' }); // the second request
      expect(p.onAccept).toHaveBeenCalledTimes(2);
      await act(async () => { settle[0]!(false); await Promise.resolve(); }); // the first one finally settles
      fireEvent.keyDown(rowA, { key: 'Enter' });
      expect(p.onAccept).toHaveBeenCalledTimes(2); // still guarded by the second
      await act(async () => { settle[1]!(false); await Promise.resolve(); });
      fireEvent.keyDown(rowA, { key: 'Enter' });
      expect(p.onAccept).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});

