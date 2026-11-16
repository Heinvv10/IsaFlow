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
import { useBankTxSummary } from '@/components/accounting/bank-transactions/useBankTxSummary';

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
});
