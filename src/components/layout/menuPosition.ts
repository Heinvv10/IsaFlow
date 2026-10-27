/**
 * Where a header menu (Create new, Settings) opens: right-aligned under its button, but always inside the viewport.
 * On a 390px phone the right-aligned panel used to start off the left edge ("ew Invoice") and run below the fold;
 * here it is shifted right and narrowed to fit, and scrolls inside itself when it is taller than the space left.
 */
import type { CSSProperties } from 'react';

const GUTTER = 8;
const GAP = 8;

export function anchoredMenuStyle(anchor: DOMRect, width: number, viewport = { width: window.innerWidth, height: window.innerHeight }): CSSProperties {
  const w = Math.min(width, viewport.width - GUTTER * 2);
  const left = Math.max(GUTTER, Math.min(anchor.right - w, viewport.width - GUTTER - w));
  const top = anchor.bottom + GAP;
  return { position: 'fixed', top, left, width: w, maxHeight: viewport.height - top - GUTTER, overflowY: 'auto' };
}
