/**
 * The in-flight guard itself: two submits in the same tick (before React re-renders the disabled button, which
 * the page-level test cannot get under) run the write once; a refusal keeps the server's message and does not
 * call onSuccess; after a submit settles the next one runs.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useGuardedSubmit } from '@/components/accounting/cashForecast13/useGuardedSubmit';

describe('useGuardedSubmit', () => {
  it('two submits in one tick run the write once', async () => {
    const { result } = renderHook(() => useGuardedSubmit());
    let resolve!: (v: { ok: true; data: unknown }) => void;
    const fn = vi.fn(() => new Promise<{ ok: true; data: unknown }>((r) => { resolve = r; }));
    const onSuccess = vi.fn();
    await act(async () => {
      const a = result.current.submit(fn, onSuccess);
      const b = result.current.submit(fn, onSuccess);
      resolve({ ok: true, data: null });
      await Promise.all([a, b]);
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.submit(async () => ({ ok: true, data: null }), onSuccess); });
    expect(onSuccess).toHaveBeenCalledTimes(2);
  });

  it('a refusal shows its message and does not call onSuccess', async () => {
    const { result } = renderHook(() => useGuardedSubmit());
    const onSuccess = vi.fn();
    await act(async () => { await result.current.submit(async () => ({ ok: false, kind: 'invalid', message: 'Weeks start on a Monday', code: null }), onSuccess); });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.error).toBe('Weeks start on a Monday');
  });
});
