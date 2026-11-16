/**
 * useBankTxSummary: only the NEWEST refresh writes state (a slow response fired before a mutation must not put
 * pre-mutation figures back), a failed first load is an error with Retry (never an empty account list), and a failed
 * later load keeps the last good figures and flags them stale. Real apiJson runs over a scripted fetch.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { summaryAcct } from '../helpers/bankSummaryFixture';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import { SOON_MS, useBankTxSummary } from '@/components/accounting/bank-transactions/useBankTxSummary';

const body = (ledgerCents: number) => new Response(JSON.stringify({ success: true, data: { asAt: '2026-11-16', accounts: [summaryAcct('a', { ledgerCents })] } }), { status: 200 });
const fail = () => new Response(JSON.stringify({ success: false, error: { message: 'boom' } }), { status: 500 });

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('useBankTxSummary', () => {
  it('two refreshes resolving out of order: the newest wins', async () => {
    const releases: Array<() => void> = [];
    const answers = [100, 200, 300]; // load #1 (mount), refresh A, refresh B
    let n = 0;
    vi.mocked(apiFetch).mockImplementation(() => {
      const mine = answers[n++]!;
      if (mine === 100) return Promise.resolve(body(100));
      return new Promise<Response>(resolve => { releases.push(() => resolve(body(mine))); });
    });
    const { result } = renderHook(() => useBankTxSummary());
    await waitFor(() => expect(result.current.accounts[0]?.ledgerCents).toBe(100));
    let a!: Promise<void>, b!: Promise<void>;
    act(() => { a = result.current.refresh(); b = result.current.refresh(); });
    // B (the newer) answers first, then the slow A: A must not overwrite B.
    await act(async () => { releases[1]!(); await b; });
    expect(result.current.accounts[0]!.ledgerCents).toBe(300);
    await act(async () => { releases[0]!(); await a; });
    expect(result.current.accounts[0]!.ledgerCents).toBe(300);
  });

  it('a failed first load is an error with a message, not an empty list; Retry loads it', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(fail());
    const { result } = renderHook(() => useBankTxSummary());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toMatch(/boom|Could not load the bank accounts/);
    expect(result.current.accounts).toEqual([]);
    vi.mocked(apiFetch).mockResolvedValueOnce(body(500));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.status).toBe('ready');
    expect(result.current.accounts[0]!.ledgerCents).toBe(500);
  });

  it('a failed later load keeps the last good figures and marks them stale; the next good load clears it', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(body(100));
    const { result } = renderHook(() => useBankTxSummary());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    vi.mocked(apiFetch).mockResolvedValueOnce(fail());
    await act(async () => { await result.current.refresh(); });
    expect(result.current.status).toBe('ready');
    expect(result.current.stale).toBe(true);
    expect(result.current.accounts[0]!.ledgerCents).toBe(100);
    vi.mocked(apiFetch).mockResolvedValueOnce(body(200));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.stale).toBe(false);
    expect(result.current.accounts[0]!.ledgerCents).toBe(200);
  });

  it('a superseding refresh that FAILS does not drop an earlier good answer that lands after it', async () => {
    const releases: Array<() => void> = [];
    vi.mocked(apiFetch).mockResolvedValueOnce(fail()); // mount load (first) fails -> error
    const { result } = renderHook(() => useBankTxSummary());
    await waitFor(() => expect(result.current.status).toBe('error'));
    let a!: Promise<void>, b!: Promise<void>;
    vi.mocked(apiFetch)
      .mockImplementationOnce(() => new Promise<Response>(resolve => { releases.push(() => resolve(body(700))); })) // A: slow, ok
      .mockResolvedValueOnce(fail()); // B: newer, fails at once
    act(() => { a = result.current.refresh(); b = result.current.refresh(); });
    await act(async () => { await b; });
    await act(async () => { releases[0]!(); await a; });
    // A's good data is shown (not the first-load error), flagged as possibly out of date because the newest request failed.
    expect(result.current.status).toBe('ready');
    expect(result.current.accounts[0]!.ledgerCents).toBe(700);
    expect(result.current.stale).toBe(true);
  });

  it('the superseded request failing alone says nothing: the newest good answer stands, not stale', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(body(100));
    const { result } = renderHook(() => useBankTxSummary());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const releases: Array<() => void> = [];
    vi.mocked(apiFetch)
      .mockImplementationOnce(() => new Promise<Response>(resolve => { releases.push(() => resolve(fail())); })) // A: slow, fails
      .mockResolvedValueOnce(body(900)); // B: newer, ok
    let a!: Promise<void>, b!: Promise<void>;
    act(() => { a = result.current.refresh(); b = result.current.refresh(); });
    await act(async () => { await b; });
    await act(async () => { releases[0]!(); await a; });
    expect(result.current.stale).toBe(false);
    expect(result.current.accounts[0]!.ledgerCents).toBe(900);
  });
});

describe('useBankTxSummary: refreshSoon (a burst costs one fetch)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.useRealTimers(); });
  const summaryCalls = () => vi.mocked(apiFetch).mock.calls.length;

  it('five calls inside the window make exactly one fetch, after the trailing edge', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => body(100));
    const { result } = renderHook(() => useBankTxSummary());
    await act(async () => { await vi.advanceTimersByTimeAsync(50); }); expect(summaryCalls(), "the mount load has been made").toBeGreaterThan(0);
    const base = summaryCalls(); // the mount load
    // Five calls 100 ms apart: 400 ms from the first, so a debounce that did not restart would have fired by now.
    act(() => { for (let i = 0; i < 5; i++) { result.current.refreshSoon(); if (i < 4) vi.advanceTimersByTime(100); } });
    expect(summaryCalls()).toBe(base);
    await act(async () => { await vi.advanceTimersByTimeAsync(SOON_MS - 1); }); // 1 ms short of the LAST call's window
    expect(summaryCalls()).toBe(base);
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(summaryCalls()).toBe(base + 1);
  });

  it('an immediate refresh() cancels a pending one (no second fetch)', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => body(100));
    const { result } = renderHook(() => useBankTxSummary());
    await act(async () => { await vi.advanceTimersByTimeAsync(50); }); expect(summaryCalls(), "the mount load has been made").toBeGreaterThan(0);
    const base = summaryCalls();
    act(() => { result.current.refreshSoon(); });
    await act(async () => { await result.current.refresh(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(SOON_MS * 2); });
    expect(summaryCalls()).toBe(base + 1);
  });

  it('unmounting clears a pending one', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => body(100));
    const { result, unmount } = renderHook(() => useBankTxSummary());
    await act(async () => { await vi.advanceTimersByTimeAsync(50); }); expect(summaryCalls(), "the mount load has been made").toBeGreaterThan(0);
    const base = summaryCalls();
    act(() => { result.current.refreshSoon(); });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(SOON_MS * 2); });
    expect(summaryCalls()).toBe(base);
  });
});
