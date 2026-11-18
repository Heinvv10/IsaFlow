/**
 * The live content width of an element (0 until measured, and wherever there is no layout), so a component can swap
 * a wide table for stacked cards by the room it actually has rather than by the viewport, which says nothing when a
 * sidebar takes 256px. Pass `attach` as the `ref` (a callback ref).
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useElementWidth(): { attach: (el: HTMLElement | null) => void; width: number } {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  const attach = useCallback((node: HTMLElement | null) => setEl(node), []);
  useBeforePaint(() => {
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return { attach, width };
}
