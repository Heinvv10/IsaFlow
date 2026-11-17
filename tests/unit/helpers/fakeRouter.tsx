/**
 * A stateful stand-in for next/router's router, with a browser history: push adds an entry, replace rewrites the current
 * one, back/forward move through them, and every change reaches subscribers (so a component using useRouter re-renders
 * with the new query). Like Next, a push/replace takes effect on a LATER tick, not synchronously.
 *   const fr = makeFakeRouter({ account_id: 'b' });
 *   vi.mock('next/router', () => ({ useRouter: () => useFakeRouter() }));   // inside the factory, via hoisted holder
 */
import { useSyncExternalStore } from 'react';
import { vi } from 'vitest';

type Query = Record<string, string | string[] | undefined>;
export interface FakeRouterHandle {
  /** What the page sees. */
  use: () => { isReady: boolean; pathname: string; query: Query; push: typeof push; replace: typeof replace };
  calls: Array<{ kind: 'push' | 'replace'; query: Query }>;
  query: () => Query;
  /** A navigation that did not come from the page (a link clicked elsewhere): a new history entry. */
  navigate: (query: Query) => Promise<void>;
  back: () => Promise<void>;
  forward: () => Promise<void>;
  /** Renders as not ready until released (the router before hydration). */
  setReady: (v: boolean) => void;
  /** Milliseconds a push/replace takes to land (default: the next microtask). */
  setLatency: (ms: number) => void;
  /** Writes are recorded but never land (a router that swallowed them): nothing comes back to the page. */
  setDropWrites: (v: boolean) => void;
  /** Writes land in the history at once but the page is told only once, after `ms` (a router that batches renders). */
  setCollapse: (ms: number) => void;
}
declare function push(url: { pathname: string; query: Query }, as?: undefined, o?: { shallow?: boolean; scroll?: boolean }): Promise<boolean>;
declare function replace(url: { pathname: string; query: Query }, as?: undefined, o?: { shallow?: boolean; scroll?: boolean }): Promise<boolean>;

export function makeFakeRouter(initial: Query = {}, pathname = '/accounting/bank-transactions'): FakeRouterHandle {
  const stack: Query[] = [{ ...initial }];
  let index = 0, ready = true, version = 0, latency = 0, drop = false, collapse = 0, collapseTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const calls: FakeRouterHandle['calls'] = [];
  let snapshot: ReturnType<FakeRouterHandle['use']> | null = null;
  const changed = () => { version += 1; snapshot = null; listeners.forEach(l => l()); };
  const later = (fn: () => void) => new Promise<boolean>(resolve => {
    const land = () => {
      if (!drop) {
        fn();
        if (collapse > 0) { snapshot = null; if (!collapseTimer) collapseTimer = setTimeout(() => { collapseTimer = null; changed(); }, collapse); } else changed();
      }
      resolve(true);
    };
    if (latency > 0) setTimeout(land, latency); else queueMicrotask(land);
  });
  const pushFn = vi.fn((url: { query: Query }) => { calls.push({ kind: 'push', query: { ...url.query } }); return later(() => { stack.splice(index + 1); stack.push({ ...url.query }); index = stack.length - 1; }); });
  const replaceFn = vi.fn((url: { query: Query }) => { calls.push({ kind: 'replace', query: { ...url.query } }); return later(() => { stack[index] = { ...url.query }; }); });
  const get = () => (snapshot ??= { isReady: ready, pathname, query: stack[index]!, push: pushFn as never, replace: replaceFn as never });
  void version;
  return {
    use: () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, get, get),
    calls,
    query: () => stack[index]!,
    navigate: async (q: Query) => { await later(() => { stack.splice(index + 1); stack.push({ ...q }); index = stack.length - 1; }); },
    back: async () => { if (index > 0) { index -= 1; await later(() => undefined); } },
    forward: async () => { if (index < stack.length - 1) { index += 1; await later(() => undefined); } },
    setReady: (v: boolean) => { ready = v; changed(); },
    setLatency: (ms: number) => { latency = ms; },
    setDropWrites: (v: boolean) => { drop = v; },
    setCollapse: (ms: number) => { collapse = ms; },
  };
}
