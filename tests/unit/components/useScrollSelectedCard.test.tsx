/** The selected card scrolls into view; an account with NO card (shown in the switcher trigger instead, WP5) scrolls nothing and breaks nothing. */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useScrollSelectedCard } from '@/components/accounting/bank-transactions/useScrollSelectedCard';

let scrolled: string[];
const orig = Element.prototype.scrollIntoView;
beforeEach(() => {
  scrolled = [];
  Element.prototype.scrollIntoView = function scroll(this: Element) { scrolled.push(this.getAttribute('data-card-key') ?? ''); };
  document.body.innerHTML = '<div data-card-key="a"></div><div data-card-key="group:g1"></div>';
});
afterEach(() => { Element.prototype.scrollIntoView = orig; document.body.innerHTML = ''; });

describe('useScrollSelectedCard', () => {
  it('scrolls the card of the selected account', () => {
    renderHook(() => useScrollSelectedCard('a'));
    expect(scrolled).toEqual(['a']);
  });
  it("a sub-account scrolls its group's card", () => {
    renderHook(() => useScrollSelectedCard('sub-1', 'g1'));
    expect(scrolled).toEqual(['group:g1']);
  });
  it('an account with no card on screen (an unpinned one, shown in the switcher) scrolls nothing and does not throw', () => {
    expect(() => renderHook(() => useScrollSelectedCard('unpinned-x'))).not.toThrow();
    expect(scrolled).toEqual([]);
  });
  it('disabled (the order not known yet) scrolls nothing; enabling it scrolls once', () => {
    const { rerender } = renderHook(({ on }) => useScrollSelectedCard('a', null, on), { initialProps: { on: false } });
    expect(scrolled).toEqual([]);
    rerender({ on: true });
    expect(scrolled).toEqual(['a']);
  });
  it('scrolls on the selection change and the first order load - not again when only other things change (a reorder, a pin toggle)', () => {
    const { rerender } = renderHook(({ id, loaded }) => useScrollSelectedCard(id, null, true, loaded), { initialProps: { id: 'a', loaded: false } });
    expect(scrolled).toEqual(['a']);
    rerender({ id: 'a', loaded: true });
    expect(scrolled).toEqual(['a', 'a']); // the order's first load: the cards moved
    rerender({ id: 'a', loaded: true }); rerender({ id: 'a', loaded: true });
    expect(scrolled).toHaveLength(2); // nothing new
    rerender({ id: 'group:g1', loaded: true });
    expect(scrolled).toEqual(['a', 'a', 'group:g1']);
  });
});
