/** Browser-neutral history positions used when Navigation API traversal is unavailable. */
import { describe, expect, it } from 'vitest';
import { historyIndexOf, installHistoryIndex } from '@/lib/historyIndex';

describe('history entries carry their index', () => {
  it("push adds one to the current entry's index and replace keeps it", () => {
    window.history.replaceState({ key: 'start' }, '');
    installHistoryIndex();
    const first = historyIndexOf(window.history.state);
    expect(first).not.toBeNull();
    window.history.pushState({ key: 'a' }, '', '/a');
    expect(historyIndexOf(window.history.state)).toBe(first! + 1);
    window.history.replaceState({ key: 'a2' }, '', '/a');
    expect(historyIndexOf(window.history.state)).toBe(first! + 1);
  });

  it('reads only a whole, non-negative index', () => {
    expect(historyIndexOf({ __isaIdx: 3 })).toBe(3);
    for (const bad of [null, undefined, {}, { __isaIdx: -1 }, { __isaIdx: 1.5 }, { __isaIdx: '2' }]) {
      expect(historyIndexOf(bad)).toBeNull();
    }
  });
});
