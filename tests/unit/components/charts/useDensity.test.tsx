import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';

const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', async () => {
  const actual = await vi.importActual<typeof import('@/lib/apiFetch')>('@/lib/apiFetch');
  return { apiFetch: (u: string, o?: RequestInit) => apiFetch(u, o), assertOk: actual.assertOk };
});
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { useDensity, SAVE_FAILED } from '@/components/accounting/reportControls/useDensity';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const rejected = () => new Response(JSON.stringify({ message: 'nope' }), { status: 403 });

beforeEach(() => { apiFetch.mockReset(); localStorage.clear(); });
afterEach(cleanup);

describe('useDensity', () => {
  it('takes the density the server holds', async () => {
    apiFetch.mockResolvedValue(ok({ data: { reports_density: 'accountant' } }));
    const { result } = renderHook(() => useDensity());
    await waitFor(() => expect(result.current.density).toBe('accountant'));
    expect(localStorage.getItem('isaflow_reports_density')).toBe('accountant');
  });

  it('surfaces a REJECTED save, which apiFetch resolves rather than throws', async () => {
    // apiFetch resolves on 4xx, so a bare .catch on the PUT catches a dropped
    // connection and nothing else. Without assertOk the toggle would show a
    // density the server refused to store and say nothing about it.
    apiFetch.mockImplementation((_u: string, o?: RequestInit) =>
      Promise.resolve(o?.method === 'PUT' ? rejected() : ok({ data: {} })));
    const { result } = renderHook(() => useDensity());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { result.current.setDensity('accountant'); });
    await waitFor(() => expect(result.current.error).toBe(SAVE_FAILED));
  });

  it('says nothing when the save is accepted', async () => {
    apiFetch.mockResolvedValue(ok({ data: {} }));
    const { result } = renderHook(() => useDensity());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { result.current.setDensity('accountant'); });
    await waitFor(() => expect(result.current.density).toBe('accountant'));
    expect(result.current.error).toBeNull();
  });

  it('clears a previous failure when the next save is attempted', async () => {
    apiFetch.mockImplementation((_u: string, o?: RequestInit) =>
      Promise.resolve(o?.method === 'PUT' ? rejected() : ok({ data: {} })));
    const { result } = renderHook(() => useDensity());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { result.current.setDensity('accountant'); });
    await waitFor(() => expect(result.current.error).toBe(SAVE_FAILED));

    apiFetch.mockResolvedValue(ok({ data: {} }));
    await act(async () => { result.current.setDensity('owner'); });
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it('does not banner a failed READ — the local value is already on screen and is this browser\'s own choice', async () => {
    localStorage.setItem('isaflow_reports_density', 'accountant');
    apiFetch.mockResolvedValue(rejected());
    const { result } = renderHook(() => useDensity());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.density).toBe('accountant');
    expect(result.current.error).toBeNull();
  });
});
