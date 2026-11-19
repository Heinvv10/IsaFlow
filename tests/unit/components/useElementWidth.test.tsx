/**
 * useElementWidth reads the attached element's width and follows it with a ResizeObserver, which it must let go of
 * when the element goes (unmount, or a different element attached): otherwise every swap of the bill lines would
 * leave an observer behind, still setting state on the old element's behalf.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useElementWidth } from '@/hooks/useElementWidth';

const observers: { target: Element | null; callback: () => void; disconnected: boolean }[] = [];
class FakeObserver {
  entry: (typeof observers)[number];
  constructor(callback: () => void) { this.entry = { target: null, callback, disconnected: false }; observers.push(this.entry); }
  observe(el: Element) { this.entry.target = el; }
  unobserve() {}
  disconnect() { this.entry.disconnected = true; }
}

afterEach(() => { cleanup(); observers.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Probe({ which }: { which: 'a' | 'b' }) {
  const { attach, width } = useElementWidth();
  return <div><div ref={which === 'a' ? attach : undefined} data-w="a" /><div ref={which === 'b' ? attach : undefined} data-w="b" /><p>{width}</p></div>;
}

it('measures the element, follows resizes, and disconnects its observer when the element changes or unmounts', () => {
  let w = 640;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-w') ? w : 0;
  });
  vi.stubGlobal('ResizeObserver', FakeObserver);
  const view = render(<Probe which="a" />);
  expect(screen.getByText('640')).toBeTruthy();
  w = 500;
  act(() => observers[0]!.callback());
  expect(screen.getByText('500')).toBeTruthy();
  view.rerender(<Probe which="b" />);
  expect(observers[0]!.disconnected, 'the old element is let go').toBe(true);
  expect(observers.at(-1)!.target?.getAttribute('data-w')).toBe('b');
  view.unmount();
  expect(observers.every((o) => o.disconnected), 'nothing is left observing after unmount').toBe(true);
});
