/** useKeyedTimeoutOnce: each key has its own timer; unmount cancels all. Fake clock. */
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useKeyedTimeoutOnce } from '@/hooks/useKeyedTimeoutOnce';

afterEach(() => { vi.useRealTimers(); });

describe('useKeyedTimeoutOnce', () => {
  it('keys run on their own clocks: B scheduled later does not extend A', () => {
    vi.useFakeTimers();
    const a = vi.fn();
    const b = vi.fn();
    const { result } = renderHook(() => useKeyedTimeoutOnce());
    result.current('a', a, 4000);
    vi.advanceTimersByTime(3000);
    result.current('b', b, 4000);
    vi.advanceTimersByTime(1000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('rescheduling a key replaces only that key', () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const other = vi.fn();
    const { result } = renderHook(() => useKeyedTimeoutOnce());
    result.current('a', first, 1000);
    result.current('b', other, 1000);
    result.current('a', second, 1000);
    vi.advanceTimersByTime(1000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('unmounting cancels every key', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const { result, unmount } = renderHook(() => useKeyedTimeoutOnce());
    result.current('a', fn, 1000);
    result.current('b', fn, 1000);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
  });
});
