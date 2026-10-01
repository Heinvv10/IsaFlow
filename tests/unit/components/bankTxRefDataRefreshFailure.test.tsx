/**
 * W1-02 LOW: refreshBankAccounts swallowed a failed fetch with an empty catch,
 * so the balance cards kept the stale list and the user was told nothing.
 * Real apiJson runs; only the network (global fetch) is stubbed.
 */
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const notifyError = vi.fn();
vi.mock('@/utils/toast', () => ({ notify: { error: (m: string) => notifyError(m), success: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { useBankTxRefData } from '@/components/accounting/bank-transactions/useBankTxRefData';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const noop = vi.fn();
const setters = (setBankAccounts: (v: never[]) => void) => ({
  setBankAccounts, setGlAccounts: noop, setSuppliers: noop, setCustomers: noop,
  setCc1Options: noop, setCc2Options: noop, setBuOptions: noop, setSelectedBank: noop,
});

beforeEach(() => { notifyError.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('a failed bank-account refresh tells the user the balances may be stale', async () => {
  const setBankAccounts = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => ok([])));
  const { result } = renderHook(() => useBankTxRefData(setters(setBankAccounts)));
  await waitFor(() => expect(setBankAccounts).toHaveBeenCalled());

  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, message: 'boom' }), { status: 500 })));
  await act(async () => { result.current.refreshBankAccounts(); });

  await waitFor(() => expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/bank account.*out of date/i)));
});

it('a successful refresh stays quiet and replaces the list', async () => {
  const setBankAccounts = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => ok([])));
  const { result } = renderHook(() => useBankTxRefData(setters(setBankAccounts)));
  await waitFor(() => expect(setBankAccounts).toHaveBeenCalled());
  setBankAccounts.mockClear();
  await act(async () => { result.current.refreshBankAccounts(); });
  await waitFor(() => expect(setBankAccounts).toHaveBeenCalledWith([]));
  expect(notifyError).not.toHaveBeenCalled();
});
