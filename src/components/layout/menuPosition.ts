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

// ─── Nav fly-outs ─────────────────────────────────────────────────────────────

/** 'below': a tab's menu under its tab. 'beside': a section's sub-panel next to its row. */
export type FlyoutSide = 'below' | 'beside';
/** The way a sub-panel opened; its own sub-panels try the same way first, so a cascade keeps one direction. */
export type FlyoutDir = 'right' | 'left';
export interface FlyoutPlacement { top: number; left: number; maxHeight?: number; dir: FlyoutDir }

type Box = { top: number; bottom: number; left: number; right: number };
/** A scrolling panel never gets less than two rows, even where the window has no room for that. */
const MIN_FLYOUT_HEIGHT = 80;

/**
 * Where a nav fly-out goes (viewport coordinates, for `position: fixed`), kept GUTTER inside the screen. A panel
 * that fits opens where it always did: under its tab at the tab's left edge, or beside its row level with the row.
 * Otherwise: a sub-panel past the bottom moves up, past the right edge opens on the left of its row (or is pulled
 * inside when neither side has room), and one taller than the screen gets the screen's height and scrolls. A tab's
 * menu never moves up over its tab: it moves left and, when too tall for the room below, scrolls.
 * A `nested` panel (it has section rows of its own) picks the side with room for one more level of its width too, when
 * one has it: otherwise its own sub-panel would flip back over the panel it came from (Library at 1366).
 * `anchor` is the row or tab as measured, so a banner above the nav is already counted.
 */
export function placeFlyout(
  anchor: Box, panel: { width: number; height: number; nested?: boolean }, viewport: { width: number; height: number },
  side: FlyoutSide, prefer: FlyoutDir = 'right',
): FlyoutPlacement {
  const maxRight = viewport.width - GUTTER;
  const maxBottom = viewport.height - GUTTER;
  if (side === 'below') {
    const top = anchor.bottom;
    const left = Math.max(GUTTER, Math.min(anchor.left, maxRight - panel.width));
    const room = maxBottom - top;
    return panel.height > room ? { top, left, maxHeight: Math.max(room, MIN_FLYOUT_HEIGHT), dir: prefer } : { top, left, dir: prefer };
  }
  const at = { right: anchor.right, left: anchor.left - panel.width };
  const fitsWith = (extra: number) => ({ right: at.right + panel.width + extra <= maxRight, left: at.left - extra >= GUTTER });
  const fits = fitsWith(0);
  const cascade = panel.nested ? fitsWith(panel.width) : fits;
  const other: FlyoutDir = prefer === 'right' ? 'left' : 'right';
  const roomRight = maxRight - anchor.right;
  const roomLeft = anchor.left - GUTTER;
  const roomier: FlyoutDir = roomRight === roomLeft ? prefer : roomRight > roomLeft ? 'right' : 'left';
  const dir = cascade[prefer] ? prefer : cascade[other] ? other : fits[prefer] ? prefer : fits[other] ? other : roomier;
  const left = Math.max(GUTTER, Math.min(at[dir], maxRight - panel.width));
  const room = maxBottom - GUTTER;
  if (panel.height > room) return { top: GUTTER, left, maxHeight: Math.max(room, MIN_FLYOUT_HEIGHT), dir };
  // Also kept below the top edge: a row scrolled up inside its parent panel takes its sub-panel with it.
  return { top: Math.max(GUTTER, Math.min(anchor.top, maxBottom - panel.height)), left, dir };
}
