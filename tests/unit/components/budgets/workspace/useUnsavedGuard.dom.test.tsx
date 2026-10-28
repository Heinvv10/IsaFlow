/**
 * useUnsavedGuard (spec §5.6): while the grid is dirty, closing the tab asks first and a Next
 * route change needs a confirm (refused → the change is aborted); a clean grid guards nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

type Handler = (url: string) => void;
const handlers = new Map<string, Set<Handler>>();
const events = {
  on: (e: string, h: Handler) => { if (!handlers.has(e)) handlers.set(e, new Set()); handlers.get(e)!.add(h); },
  off: (e: string, h: Handler) => { handlers.get(e)?.delete(h); },
  emit: vi.fn((e: string, url = '') => { for (const h of handlers.get(e) ?? []) h(url); }),
};
vi.mock('next/router', () => ({ useRouter: () => ({ events, asPath: '/accounting/budgets/workspace' }) }));

import { useUnsavedGuard } from '@/components/accounting/budgets/workspace/useUnsavedGuard';

const unload = () => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

beforeEach(() => { handlers.clear(); events.emit.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('useUnsavedGuard', () => {
  it('guards nothing while clean', () => {
    renderHook(() => useUnsavedGuard(0));
    expect(unload()).toBe(false);
    expect(handlers.get('routeChangeStart')?.size ?? 0).toBe(0);
  });

  it('asks before unload while dirty, and stops asking once clean', () => {
    const { rerender } = renderHook(({ n }) => useUnsavedGuard(n), { initialProps: { n: 3 } });
    expect(unload()).toBe(true);
    rerender({ n: 0 });
    expect(unload()).toBe(false);
  });

  it('a refused confirm aborts the route change; an accepted one lets it go', () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    renderHook(() => useUnsavedGuard(2, 'Leave?'));
    expect(() => events.emit('routeChangeStart', '/accounting')).toThrow();
    expect(confirm).toHaveBeenCalledWith('Leave?');
    expect(events.emit).toHaveBeenCalledWith('routeChangeError');
    confirm.mockReturnValue(true);
    expect(() => events.emit('routeChangeStart', '/accounting')).not.toThrow();
  });
});
