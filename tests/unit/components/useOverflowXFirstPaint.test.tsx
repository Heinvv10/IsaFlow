/**
 * useOverflowX measures before paint: the commit that attaches the element already shows the right answer, so the
 * "scroll sideways" hint never flashes in (or out) for a frame. flushSync commits without waiting for passive effects,
 * so a measure done in useEffect would still read false here.
 */
import { afterEach, expect, it } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { useOverflowX } from '@/hooks/useOverflowX';

function Probe(): JSX.Element {
  const { attach, overflows } = useOverflowX();
  return <div ref={attach} data-testid="box">{String(overflows)}</div>;
}

let root: Root | null = null;
afterEach(() => { root?.unmount(); root = null; document.body.innerHTML = ''; });

it('reports overflow in the first synchronous commit', () => {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const before = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = false;
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 500 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 300 });
  try {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    flushSync(() => root!.render(<Probe />));
    expect(host.textContent).toBe('true');
  } finally {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    g.IS_REACT_ACT_ENVIRONMENT = before;
  }
});
