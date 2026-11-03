/**
 * Each history entry's position in this tab's history, kept in the entry's own `history.state` (`__isaIdx`), so a
 * page can tell how far a back/forward moved and undo it with `history.go(delta)` (PR S: the invoice editor's "Stay"
 * on a Back it asked about). Next's pages router writes history.state itself on every push and replace; the two are
 * wrapped once, for the tab's life, to carry the index:
 *   - a push is the current entry's index + 1 (the browser drops every forward entry on a push);
 *   - a replace keeps the current entry's index (a popped entry's own, read from its state before Next replaces it).
 * The first entry this document sees takes `history.length - 1` (right for a fresh load: nothing lies ahead of it) or
 * the index it already carries (a reload, a return from another document). An entry with no object state (a hash
 * change) has no index, and a reader that gets none must not guess.
 */
const KEY = '__isaIdx';
let installed = false;

/** The index an entry's state carries, or null. */
export function historyIndexOf(state: unknown): number | null {
  const idx = state && typeof state === 'object' ? (state as Record<string, unknown>)[KEY] : undefined;
  return typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 ? idx : null;
}

const stamp = (state: unknown, idx: number): unknown =>
  (state && typeof state === 'object' ? { ...(state as Record<string, unknown>), [KEY]: idx } : state);

/** Wraps pushState and replaceState once (client only). Safe to call more than once. */
export function installHistoryIndex(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const history = window.history;
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  const here = () => historyIndexOf(history.state) ?? Math.max(history.length - 1, 0);
  history.pushState = (state: unknown, unused: string, url?: string | URL | null) => push(stamp(state, here() + 1), unused, url);
  history.replaceState = (state: unknown, unused: string, url?: string | URL | null) => replace(stamp(state, here()), unused, url);
  if (historyIndexOf(history.state) === null) replace(stamp(history.state, here()), '');
}
