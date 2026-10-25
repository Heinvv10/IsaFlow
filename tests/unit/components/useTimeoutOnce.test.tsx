/** useTimeoutOnce: scheduling again replaces the pending timer; unmounting cancels it. Fake clock, no waiting. */
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTimeoutOnce } from '@/hooks/useTimeoutOnce';

afterEach(() => { vi.useRealTimers(); });

describe('useTimeoutOnce', () => {
  it('fires once after the delay', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const { result } = renderHook(() => useTimeoutOnce());
    result.current(fn, 1000);
    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a second schedule replaces the first: only the second fires, and the countdown restarts', () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const { result } = renderHook(() => useTimeoutOnce());
    result.current(first, 1000);
    vi.advanceTimersByTime(600);
    result.current(second, 1000);
    vi.advanceTimersByTime(600);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('unmounting before it fires cancels it', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const { result, unmount } = renderHook(() => useTimeoutOnce());
    result.current(fn, 1000);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns a stable function across renders', () => {
    const { result, rerender } = renderHook(() => useTimeoutOnce());
    const before = result.current;
    rerender();
    expect(result.current).toBe(before);
  });
});
