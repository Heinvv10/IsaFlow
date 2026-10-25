// The load / debounce / cancel plumbing of every remote picker, on its own, with fake timers and deferred
// responses so each ordering is deterministic (the component tests only see the happy orderings).
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/apiFetch';
import { useRemoteOptions, type FetchResult } from '@/components/ui/pickers/useRemoteOptions';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

interface Call { query: string; signal: AbortSignal; initial: boolean; resolve: (r: FetchResult) => void; reject: (e: unknown) => void }

function setup() {
  const calls: Call[] = [];
  const fetchOptions = vi.fn((query: string, signal: AbortSignal, ctx: { initial: boolean }) =>
    new Promise<FetchResult>((resolve, reject) => { calls.push({ query, signal, initial: ctx.initial, resolve, reject }); }));
  const hook = renderHook(() => useRemoteOptions(fetchOptions, 'Could not load - try again'));
  return { calls, fetchOptions, ...hook };
}
const opt = (v: string) => ({ options: [{ value: v, label: v }] });
const settle = async () => { await act(async () => { await Promise.resolve(); }); };
const advance = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };

describe('useRemoteOptions', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts as loading, so the render that opens the dropdown says Loading and not "No matches"', () => {
    const { result } = setup();
    expect(result.current.loading).toBe(true);
    expect(result.current.options).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('requests nothing until opened; opening requests the empty query, flagged initial', async () => {
    const { result, calls } = setup();
    expect(calls).toHaveLength(0);
    act(() => result.current.onOpenChange(true));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ query: '', initial: true });
    await act(async () => { calls[0]!.resolve({ ...opt('a'), hint: 'only 1' }); });
    expect(result.current).toMatchObject({ loading: false, hint: 'only 1', options: [{ value: 'a', label: 'a' }] });
  });

  it('refetches on every open and is loading again once closed', async () => {
    const { result, calls } = setup();
    act(() => result.current.onOpenChange(true));
    await act(async () => { calls[0]!.resolve(opt('a')); });
    act(() => result.current.onOpenChange(false));
    expect(result.current.loading).toBe(true);
    act(() => result.current.onOpenChange(true));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ query: '', initial: true });
  });

  it('debounces typing: three keystrokes inside the window make one request with the last query', async () => {
    const { result, calls } = setup();
    act(() => result.current.onOpenChange(true));
    await act(async () => { calls[0]!.resolve(opt('a')); });
    for (const q of ['a', 'ac', 'acm']) { act(() => result.current.onSearch(q)); await advance(100); }
    expect(calls).toHaveLength(1);
    await advance(149);
    expect(calls).toHaveLength(1);
    await advance(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ query: 'acm', initial: false });
  });

  it('drops the response of a superseded request, whichever order they settle in', async () => {
    const { result, calls } = setup();
    act(() => result.current.onOpenChange(true));
    act(() => result.current.onSearch('b'));
    await advance(250);
    expect(calls).toHaveLength(2);
    await act(async () => { calls[1]!.resolve(opt('new')); });
    await act(async () => { calls[0]!.resolve(opt('stale')); });
    expect(result.current.options).toEqual([{ value: 'new', label: 'new' }]);
    expect(result.current.loading).toBe(false);
  });

  it('drops the failure of a superseded request too', async () => {
    const { result, calls } = setup();
    act(() => result.current.onOpenChange(true));
    act(() => result.current.onSearch('b'));
    await advance(250);
    await act(async () => { calls[1]!.resolve(opt('new')); });
    await act(async () => { calls[0]!.reject(new Error('late')); });
    expect(result.current.error).toBeNull();
  });

  it('aborts the in-flight request when a newer one starts', async () => {
    const { result, calls } = setup();
    act(() => result.current.onOpenChange(true));
    expect(calls[0]!.signal.aborted).toBe(false);
    act(() => result.current.onSearch('b'));
    await advance(250);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls[1]!.signal.aborted).toBe(false);
  });

  it('closing aborts the in-flight request and cancels a pending debounced search', async () => {
    const { result, calls } = setup();
    act(() => result.current.onOpenChange(true));
    act(() => result.current.onSearch('typed'));
    act(() => result.current.onOpenChange(false));
    await advance(1000);
    expect(calls).toHaveLength(1); // the 'typed' search never fired
    expect(calls[0]!.signal.aborted).toBe(true);
  });

  it('unmounting cancels a pending search and aborts what is in flight', async () => {
    const { result, calls, unmount } = setup();
    act(() => result.current.onOpenChange(true));
    act(() => result.current.onSearch('typed'));
    unmount();
    await advance(1000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal.aborted).toBe(true);
  });

  it('reports a failure with the server message, and clears it the moment the next request starts', async () => {
    const { result, calls } = setup();
    act(() => result.current.onOpenChange(true));
    await act(async () => { calls[0]!.reject(new ApiRequestError('server says no', 500)); });
    expect(result.current.error).toBe('server says no');
    expect(result.current.loading).toBe(false);
    act(() => result.current.onSearch('retry'));
    expect(result.current.error).toBeNull(); // typing again must not leave the old alert up
    expect(result.current.loading).toBe(true);
    await settle();
  });

  it('uses the fallback message for a failure that carries none of its own', async () => {
    const { result, calls } = setup();
    act(() => result.current.onOpenChange(true));
    await act(async () => { calls[0]!.reject(new TypeError('Failed to fetch')); });
    expect(result.current.error).toBe('Could not load - try again');
  });
});
