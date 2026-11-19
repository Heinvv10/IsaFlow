/**
 * Keeps an open nav fly-out panel inside the viewport (placeFlyout in menuPosition.ts) as a `position: fixed` box, so a
 * scrolling parent panel cannot clip it either. Placed before the first paint, and again on window resize, on any
 * scroll (a parent panel scrolled under it) and whenever an ancestor of its anchor changes size (a banner appearing
 * above the nav shrinks the shell below it).
 *
 * The app shell is overflow-hidden: a focus() that has to scroll an item into view scrolls the shell itself and
 * shifts the whole app. `focusInPanel` focuses without scrolling and reveals the item inside its own panel only.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { placeFlyout, type FlyoutDir, type FlyoutPlacement, type FlyoutSide } from './menuPosition';

const PANEL = '[data-nav-panel], [data-sidebar-flyout]';

export function focusInPanel(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.focus({ preventScroll: true });
  const panel = el.closest<HTMLElement>(PANEL);
  if (!panel || panel.scrollHeight <= panel.clientHeight) return;
  const box = panel.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const top = box.top + panel.clientTop;
  const bottom = top + panel.clientHeight;
  if (r.top < top) panel.scrollTop -= top - r.top;
  else if (r.bottom > bottom) panel.scrollTop += r.bottom - bottom;
}

const same = (a: FlyoutPlacement | null, b: FlyoutPlacement) =>
  !!a && a.top === b.top && a.left === b.left && a.maxHeight === b.maxHeight && a.dir === b.dir;

interface PlacementOptions {
  side: FlyoutSide;
  /** The way the parent panel opened (placeFlyout tries it first). */
  prefer?: FlyoutDir;
  /** The panel has section rows of its own, so it wants room for one more level (placeFlyout). */
  nested?: boolean;
  /**
   * Re-place when this changes while the panel stays open: the sidebar's tab id, or the parent panel's `at`. A parent
   * re-placed (a banner moved its tab) moves this panel's row without resizing anything this panel listens to.
   */
  follow?: string;
}

/** `anchor`: the tab or row the panel belongs to (read when measuring, so a ref filled later is fine). */
export function useFlyoutPlacement(
  open: boolean, anchor: () => HTMLElement | null | undefined, panelRef: RefObject<HTMLElement>,
  { side, prefer = 'right', nested = false, follow }: PlacementOptions,
): { style: CSSProperties; dir: FlyoutDir; at: string } {
  const [place, setPlace] = useState<FlyoutPlacement | null>(null);
  const measure = () => {
    const a = anchor();
    const el = panelRef.current;
    if (!a || !el) return;
    const doc = document.documentElement;
    const next = placeFlyout(
      a.getBoundingClientRect(),
      // scrollHeight is the content's full height even while a max-height caps the box; plus the borders.
      { width: el.offsetWidth, height: el.scrollHeight + el.offsetHeight - el.clientHeight, nested },
      { width: doc.clientWidth || window.innerWidth, height: doc.clientHeight || window.innerHeight },
      side, prefer,
    );
    setPlace(prev => (same(prev, next) ? prev : next));
  };
  // The latest anchor and measure, for the listeners below without re-subscribing on every render (`anchor` is
  // usually an inline arrow).
  const latest = useRef({ anchor, measure });
  useLayoutEffect(() => { latest.current = { anchor, measure }; });

  useLayoutEffect(() => {
    if (!open) { setPlace(null); return undefined; }
    const run = () => latest.current.measure();
    run();
    window.addEventListener('resize', run);
    window.addEventListener('scroll', run, true);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(run);
    for (let e = latest.current.anchor()?.parentElement; e && ro; e = e.parentElement) ro.observe(e);
    return () => {
      window.removeEventListener('resize', run);
      window.removeEventListener('scroll', run, true);
      ro?.disconnect();
    };
  }, [open, side, prefer, nested, follow]);

  const style: CSSProperties = place
    ? { position: 'fixed', top: place.top, left: place.left, ...(place.maxHeight === undefined ? {} : { maxHeight: place.maxHeight, overflowY: 'auto', overscrollBehavior: 'contain' }) }
    : { position: 'fixed' };
  return { style, dir: place?.dir ?? prefer, at: place ? `${place.top},${place.left}` : '' };
}
