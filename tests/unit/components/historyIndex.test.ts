// @vitest-environment happy-dom
/**
 * PR S round eleven: each history entry carries its position (src/lib/historyIndex.ts), so the invoice editor's Stay
 * can undo a back/forward exactly. A push is the current entry's index + 1; a replace keeps the current entry's index
 * (a popped entry's own); an entry with no object state (a hash change) gets none.
 */
import { describe, expect, it, vi } from 'vitest';
import { historyIndexOf, installHistoryIndex } from '@/lib/historyIndex';

describe('history entries carry their index', () => {
  it("push adds one to the current entry's; replace keeps it; a re-install changes nothing; null state carries none", () => {
    window.history.replaceState({ key: 'start' }, ''); // before install: unstamped
    installHistoryIndex();
    const first = historyIndexOf(window.history.state);
    expect(first).not.toBeNull(); // the entry the document opened on is stamped at install
    window.history.pushState({ key: 'a' }, '', '/a');
    expect(historyIndexOf(window.history.state)).toBe(first! + 1);
    window.history.replaceState({ key: 'a2', url: '/a' }, '', '/a'); // Next replaces with a fresh object: index kept
    expect(historyIndexOf(window.history.state)).toBe(first! + 1);
    installHistoryIndex();
    window.history.pushState({ key: 'b' }, '', '/b');
    expect(historyIndexOf(window.history.state)).toBe(first! + 2); // wrapped once, not twice (that would add 2)
    window.history.replaceState(null, '', '/b#x');
    expect(historyIndexOf(window.history.state)).toBeNull();
  });

  it('a replace keeps the current entry\'s index even with entries ahead of it (a popped entry: not history.length - 1)', () => {
    installHistoryIndex();
    window.history.pushState({ key: 'here' }, '', '/here');
    const here = historyIndexOf(window.history.state)!;
    const ahead = vi.spyOn(window.history, 'length', 'get').mockReturnValue(here + 10); // forward entries exist
    try {
      window.history.replaceState({ key: 'here', url: '/here' }, '', '/here'); // as Next does on a pop
      expect(historyIndexOf(window.history.state)).toBe(here);
    } finally {
      ahead.mockRestore();
    }
  });

  it('reads only a whole, non-negative index', () => {
    expect(historyIndexOf({ __isaIdx: 3 })).toBe(3);
    for (const bad of [null, undefined, 'x', {}, { __isaIdx: -1 }, { __isaIdx: 1.5 }, { __isaIdx: '2' }]) expect(historyIndexOf(bad)).toBeNull();
  });
});
