/**
 * True while an element's content is wider than its box, so a "scroll sideways" hint shows exactly when columns are
 * clipped, whatever the viewport. Pass the returned `attach` as the `ref` (a callback ref) on the scrolling element.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

// useLayoutEffect warns when these forms render on the server, and there is nothing to measure there.
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useOverflowX(): { attach: (el: HTMLElement | null) => void; overflows: boolean } {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const attach = useCallback((node: HTMLElement | null) => setEl(node), []);
  useBeforePaint(() => {
    if (!el) return undefined;
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const table = el.firstElementChild;
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, [el]);
  return { attach, overflows };
}
