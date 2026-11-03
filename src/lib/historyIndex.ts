/**
 * Adds a position to each Next.js history entry so pages can undo an exact
 * back/forward traversal where the browser has no Navigation API.
 */
const KEY = '__isaIdx';
let installed = false;

export function historyIndexOf(state: unknown): number | null {
  const index = state && typeof state === 'object' ? (state as Record<string, unknown>)[KEY] : undefined;
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : null;
}

const stamp = (state: unknown, index: number): unknown =>
  (state && typeof state === 'object' ? { ...(state as Record<string, unknown>), [KEY]: index } : state);

/** Wraps the History API once for this document. */
export function installHistoryIndex(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const history = window.history;
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  const current = () => historyIndexOf(history.state) ?? Math.max(history.length - 1, 0);

  history.pushState = (state: unknown, unused: string, url?: string | URL | null) =>
    push(stamp(state, current() + 1), unused, url);
  history.replaceState = (state: unknown, unused: string, url?: string | URL | null) =>
    replace(stamp(state, current()), unused, url);

  if (historyIndexOf(history.state) === null) replace(stamp(history.state, current()), '');
}
