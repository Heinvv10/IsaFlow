/**
 * Where a portalled or fixed dropdown panel goes relative to its trigger (viewport coordinates).
 * Down unless there is less room below than the panel wants and more room above; the panel's own
 * max height is the room on the chosen side, so it never runs off the viewport.
 */

export interface PanelPlacement {
  /** Viewport y of the panel's top edge when it opens downward. */
  top?: number;
  /** Distance from the viewport's bottom edge to the panel's bottom edge when it opens upward. */
  bottom?: number;
  maxHeight: number;
}

const GAP = 4;
const MARGIN = 8;
/** A panel is never squeezed below this: a shorter one cannot show a row and its search box. */
const MIN_HEIGHT = 120;

/** `wanted` is the panel's natural height (search box + list + footer). */
export function placePanel(trigger: { top: number; bottom: number }, viewportHeight: number, wanted: number): PanelPlacement {
  const below = viewportHeight - trigger.bottom - GAP - MARGIN;
  const above = trigger.top - GAP - MARGIN;
  if (below >= wanted || below >= above) {
    return { top: trigger.bottom + GAP, maxHeight: Math.max(below, MIN_HEIGHT) };
  }
  return { bottom: viewportHeight - trigger.top + GAP, maxHeight: Math.max(above, MIN_HEIGHT) };
}
